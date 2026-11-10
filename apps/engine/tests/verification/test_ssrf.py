import httpx
import pytest

from settld_engine.verification.ssrf import BlockedTargetError, is_public_ip, pin_target

pytestmark = pytest.mark.anyio


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",  # loopback
        "10.1.2.3",  # private
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",  # link-local: the cloud metadata endpoint
        "100.64.0.1",  # carrier-grade NAT
        "0.0.0.0",  # noqa: S104 (a value under test, not a bind address)
        "224.0.0.1",  # multicast: ipaddress calls it global
        "::1",
        "fe80::1",
        "fc00::1",
        "::ffff:127.0.0.1",  # IPv4-mapped loopback
        "64:ff9b::7f00:1",  # NAT64 prefix wrapping 127.0.0.1: ipaddress calls it global
        "ff02::1",
    ],
)
def test_non_public_addresses_are_rejected(ip: str) -> None:
    assert not is_public_ip(ip)


@pytest.mark.parametrize("ip", ["8.8.8.8", "93.184.215.14", "2606:4700::1111", "::ffff:8.8.8.8"])
def test_public_addresses_are_allowed(ip: str) -> None:
    assert is_public_ip(ip)


async def test_pins_the_first_checked_address_and_keeps_the_hostname_for_host_and_sni() -> None:
    async def resolver(host: str, port: int) -> list[str]:
        assert (host, port) == ("shop.example", 443)
        return ["93.184.215.14", "2606:4700::1111"]

    target = await pin_target(httpx.URL("https://shop.example/path?q=1"), resolver)

    assert target.ip == "93.184.215.14"
    assert target.url == httpx.URL("https://93.184.215.14/path?q=1")
    assert target.host_header == "shop.example"
    assert target.sni_hostname == "shop.example"


async def test_a_non_default_port_stays_in_the_host_header() -> None:
    async def resolver(host: str, port: int) -> list[str]:
        return ["2606:4700::1111"]

    target = await pin_target(httpx.URL("https://shop.example:8443/"), resolver)

    assert target.url.host == "2606:4700::1111"
    assert target.url.port == 8443
    assert target.host_header == "shop.example:8443"


async def test_one_private_record_among_public_ones_blocks_the_host() -> None:
    # The attacker controls the DNS zone: if any answer is private, a later connection
    # (keep-alive, retry, happy eyeballs) could land on it.
    async def resolver(host: str, port: int) -> list[str]:
        return ["93.184.215.14", "10.0.0.1"]

    with pytest.raises(BlockedTargetError, match=r"10\.0\.0\.1"):
        await pin_target(httpx.URL("https://mixed.example/"), resolver)


async def test_plain_http_is_blocked_before_resolving() -> None:
    async def resolver(host: str, port: int) -> list[str]:
        raise AssertionError("must not resolve")

    with pytest.raises(BlockedTargetError, match="https"):
        await pin_target(httpx.URL("http://shop.example/"), resolver)


async def test_an_ip_literal_is_checked_like_a_resolved_one() -> None:
    async def resolver(host: str, port: int) -> list[str]:
        return [host]

    with pytest.raises(BlockedTargetError):
        await pin_target(httpx.URL("https://169.254.169.254/latest/meta-data/"), resolver)
