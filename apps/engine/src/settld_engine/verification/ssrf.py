# SSRF protection for probes that fetch a URL the parties wrote (verification-adapters.md
# section 3, ADR-0008). The Engine runs next to Postgres, Core API and the cloud metadata
# endpoint; a contract that says "check https://169.254.169.254/..." must never reach them.
#
# Why resolve here and connect to the IP, instead of checking and then letting httpx connect by
# name: httpx would resolve the name a second time. A DNS server under the attacker's control
# can answer a public IP to the check and 127.0.0.1 to the connection (DNS rebinding). Pinning
# the request to the address that passed the check closes that gap. TLS still verifies the
# certificate against the hostname, because the hostname travels as SNI.
import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

Resolver = Callable[[str, int], Awaitable[list[str]]]

# RFC 6052 well-known NAT64 prefix: 64:ff9b::7f00:1 reaches 127.0.0.1 through a NAT64 gateway,
# yet ipaddress reports it as global.
NAT64 = ipaddress.IPv6Network("64:ff9b::/96")


class BlockedTargetError(Exception):
    """The URL points somewhere a probe must not go. The verdict is FAIL, never a retry."""


@dataclass(frozen=True)
class PinnedTarget:
    url: httpx.URL  # same URL with the checked IP as host
    ip: str
    host_header: str
    sni_hostname: str


def is_public_ip(ip: str) -> bool:
    address = ipaddress.ip_address(ip)
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return is_public_ip(str(address.ipv4_mapped))
        if address in NAT64:
            return is_public_ip(str(ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)))
    # is_global already excludes private, loopback, link-local, CGNAT and reserved ranges.
    # Multicast is the exception it lets through.
    return address.is_global and not address.is_multicast


async def resolve_host(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    # dict.fromkeys dedupes and keeps the resolver's order (it lists preferred addresses first).
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


async def pin_target(url: httpx.URL, resolver: Resolver) -> PinnedTarget:
    if url.scheme != "https":
        raise BlockedTargetError(f"only https URLs can be probed, got {url.scheme}://")
    host = url.raw_host.decode("ascii")  # IDNA-encoded, as DNS and SNI expect
    port = url.port or 443
    addresses = await resolver(host, port)
    if not addresses:
        raise OSError(f"{host} did not resolve")
    # Every answer must be public, not only the one we pick: a mixed answer means the zone is
    # trying something, and the connection layer could fall back to another record.
    for ip in addresses:
        if not is_public_ip(ip):
            raise BlockedTargetError(f"{host} resolves to {ip}, which is not a public address")
    ip = addresses[0]
    return PinnedTarget(
        url=url.copy_with(host=ip),
        ip=ip,
        host_header=host if url.port is None else f"{host}:{port}",
        sni_hostname=host,
    )
