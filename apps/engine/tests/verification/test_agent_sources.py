"""What the evaluator may read is decided by code, before the model sees anything (ADR-0019)."""

import hashlib
import io
import stat
import zipfile
from pathlib import Path

import pytest

from settld_engine.contracts import AiCheckConfig, EvidenceLink
from settld_engine.verification.agent.archive import Archive, ArchiveError
from settld_engine.verification.agent.sources import origin_of, resolve_sources

SHA = "a" * 40


def config(
    sources: list[str], url: str | None = None, repository: str | None = None
) -> AiCheckConfig:
    return AiCheckConfig(
        sources=sources,  # type: ignore[arg-type]
        url=url,
        repository=repository,
        guidance="The landing lists the three plans",
    )


def zip_bytes(files: dict[str, bytes], **info: int) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            entry = zipfile.ZipInfo(name)
            entry.compress_type = zipfile.ZIP_DEFLATED
            for key, value in info.items():
                setattr(entry, key, value)
            z.writestr(entry, data)
    return buffer.getvalue()


def stored(tmp_path: Path, data: bytes) -> tuple[Path, str]:
    digest = hashlib.sha256(data).hexdigest()
    path = tmp_path / f"{digest}.zip"
    path.write_bytes(data)
    return path, f"sha256:{digest}"


# --- origins and allowlist


def test_an_origin_is_https_scheme_host_and_port() -> None:
    assert origin_of("https://Shop.Example/pricing?x=1") == "https://shop.example"
    assert origin_of("https://shop.example:443/") == "https://shop.example"
    assert origin_of("https://shop.example:8443/a") == "https://shop.example:8443"
    assert origin_of("http://shop.example/") is None
    assert origin_of("javascript:alert(1)") is None


def test_pages_come_from_the_approved_url_and_the_delivered_links(tmp_path: Path) -> None:
    links = [EvidenceLink(kind="URL", url="https://demo.example/app")]
    found = resolve_sources(
        config(["HTTP_RESPONSE"], url="https://shop.example/"), links, None, tmp_path
    )

    assert found.origins == frozenset({"https://shop.example", "https://demo.example"})
    assert found.entry_pages == ["https://shop.example/", "https://demo.example/app"]


def test_nothing_is_read_from_a_source_the_contract_did_not_approve(tmp_path: Path) -> None:
    links = [
        EvidenceLink(kind="REPOSITORY", url="https://github.com/acme/site", commit_sha=SHA),
        EvidenceLink(kind="URL", url="https://demo.example/"),
    ]
    found = resolve_sources(config(["HTTP_RESPONSE"]), links, None, tmp_path)

    assert found.repository is None
    assert found.entry_pages == ["https://demo.example/"]


def test_a_public_github_repository_is_read_at_its_fixed_commit(tmp_path: Path) -> None:
    links = [
        EvidenceLink(kind="REPOSITORY", url="https://github.com/acme/site.git", commit_sha=SHA)
    ]
    found = resolve_sources(config(["REPOSITORY"]), links, None, tmp_path)

    assert found.repository is not None
    assert (found.repository.owner, found.repository.name) == ("acme", "site")
    assert found.repository.commit_sha == SHA


def test_a_repository_without_a_commit_is_not_read(tmp_path: Path) -> None:
    links = [EvidenceLink(kind="REPOSITORY", url="https://github.com/acme/site")]
    found = resolve_sources(config(["REPOSITORY"]), links, None, tmp_path)

    assert found.repository is None
    assert found.skipped


def test_a_repository_other_than_the_one_in_the_contract_is_not_read(tmp_path: Path) -> None:
    links = [EvidenceLink(kind="REPOSITORY", url="https://github.com/other/site", commit_sha=SHA)]
    found = resolve_sources(config(["REPOSITORY"], repository="acme/site"), links, None, tmp_path)

    assert found.repository is None
    assert found.skipped


def test_a_repository_outside_github_is_not_read(tmp_path: Path) -> None:
    links = [EvidenceLink(kind="REPOSITORY", url="https://gitlab.com/acme/site", commit_sha=SHA)]
    assert resolve_sources(config(["REPOSITORY"]), links, None, tmp_path).repository is None


def test_a_delivered_file_is_found_by_its_hash_in_the_deliveries_folder(tmp_path: Path) -> None:
    path, digest = stored(tmp_path, zip_bytes({"a.txt": b"hi"}))
    links = [EvidenceLink(kind="FILE", url="https://api.example/f", file_hash=digest)]
    found = resolve_sources(config(["FILES"]), links, None, tmp_path)

    assert [f.path for f in found.archives] == [path]


def test_notes_are_read_only_when_approved(tmp_path: Path) -> None:
    assert resolve_sources(config(["NOTES"]), [], "done", tmp_path).notes == "done"
    assert resolve_sources(config(["HTTP_RESPONSE"]), [], "done", tmp_path).notes is None


# --- the delivered .zip


def test_an_archive_opens_only_when_its_hash_matches(tmp_path: Path) -> None:
    path, digest = stored(tmp_path, zip_bytes({"index.html": b"<h1>Hi</h1>"}))

    archive = Archive.open(path, digest)
    assert archive.entries() == [("index.html", 11)]
    assert archive.read("index.html", 1000) == b"<h1>Hi</h1>"

    path.write_bytes(zip_bytes({"index.html": b"<h1>Swapped</h1>"}))
    with pytest.raises(ArchiveError, match="hash"):
        Archive.open(path, digest)


def test_a_missing_archive_is_an_error_not_a_crash(tmp_path: Path) -> None:
    with pytest.raises(ArchiveError):
        Archive.open(tmp_path / "missing.zip", "sha256:" + "0" * 64)


def test_a_file_that_is_not_a_zip_is_refused(tmp_path: Path) -> None:
    path, digest = stored(tmp_path, b"MZ this is an executable")
    with pytest.raises(ArchiveError):
        Archive.open(path, digest)


@pytest.mark.parametrize("name", ["../evil.txt", "/etc/passwd", "a/../../b", "C:/win.ini"])
def test_paths_that_leave_the_archive_are_refused(tmp_path: Path, name: str) -> None:
    path, digest = stored(tmp_path, zip_bytes({name: b"x"}))
    with pytest.raises(ArchiveError, match="path"):
        Archive.open(path, digest)


def test_a_symbolic_link_is_refused(tmp_path: Path) -> None:
    data = zip_bytes({"link": b"/etc/passwd"}, external_attr=(stat.S_IFLNK | 0o777) << 16)
    path, digest = stored(tmp_path, data)
    with pytest.raises(ArchiveError, match="link"):
        Archive.open(path, digest)


def test_a_zip_bomb_is_refused_by_its_ratio(tmp_path: Path) -> None:
    path, digest = stored(tmp_path, zip_bytes({"zeros.bin": b"\0" * (30 * 1024 * 1024)}))
    with pytest.raises(ArchiveError, match=r"ratio|uncompressed"):
        Archive.open(path, digest)


def test_too_many_entries_are_refused(tmp_path: Path) -> None:
    path, digest = stored(tmp_path, zip_bytes({f"f{i}.txt": b"x" for i in range(2001)}))
    with pytest.raises(ArchiveError, match="entries"):
        Archive.open(path, digest)


def test_reading_an_entry_never_returns_more_than_the_limit(tmp_path: Path) -> None:
    path, digest = stored(tmp_path, zip_bytes({"big.txt": b"a" * 5000}))
    archive = Archive.open(path, digest)

    with pytest.raises(ArchiveError, match="too large"):
        archive.read("big.txt", 1000)
    with pytest.raises(ArchiveError, match="no entry"):
        archive.read("other.txt", 1000)


def test_folders_are_not_listed_as_files(tmp_path: Path) -> None:
    path, digest = stored(tmp_path, zip_bytes({"src/": b"", "src/app.py": b"print(1)"}))
    assert Archive.open(path, digest).entries() == [("src/app.py", 8)]
