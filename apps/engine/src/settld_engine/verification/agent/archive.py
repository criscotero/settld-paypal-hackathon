# A delivered .zip, opened for reading only (ADR-0020, hackathon version).
#
# Core checked these same limits on upload. They are checked again here because the Engine must
# not trust the disk: the file name is its hash, and a file whose bytes no longer match it is
# not the file that was delivered (constitution VII). A mismatch is an error, so the criterion
# ends UNCERTAIN instead of a verdict about different content.
#
# Nothing is extracted to disk and nothing is executed: each entry is read into memory, with a
# limit, only when the model asks for it. That leaves no path traversal to exploit and no file
# for anything to run.
import hashlib
import io
import stat
import zipfile
from pathlib import Path, PurePosixPath

MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
MAX_ENTRIES = 2000
MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
MAX_RATIO = 100
# Tiny files of repeated characters compress far beyond 100:1 and are harmless; the ratio only
# matters once the uncompressed size is large enough to hurt.
RATIO_FLOOR_BYTES = 1024 * 1024


class ArchiveError(Exception):
    """Why the archive or an entry cannot be read, in words safe to show the model."""


def check_entry_name(name: str) -> None:
    path = PurePosixPath(name.replace("\\", "/"))
    if path.is_absolute() or (len(name) > 1 and name[1] == ":") or ".." in path.parts:
        raise ArchiveError(f"unsafe path in the archive: {name[:200]}")


def validate(z: zipfile.ZipFile, archive_bytes: int) -> None:
    infos = z.infolist()
    if len(infos) > MAX_ENTRIES:
        raise ArchiveError(f"too many entries: {len(infos)} (limit {MAX_ENTRIES})")
    total = 0
    for info in infos:
        check_entry_name(info.filename)
        if stat.S_ISLNK(info.external_attr >> 16):
            raise ArchiveError(f"symbolic link in the archive: {info.filename[:200]}")
        total += info.file_size
    if total > MAX_UNCOMPRESSED_BYTES:
        raise ArchiveError(f"too large uncompressed: {total} bytes")
    if total > RATIO_FLOOR_BYTES and total > MAX_RATIO * max(archive_bytes, 1):
        raise ArchiveError(f"compression ratio above {MAX_RATIO}:1")


class Archive:
    def __init__(self, z: zipfile.ZipFile) -> None:
        self._zip = z
        self._files = {i.filename: i for i in z.infolist() if not i.is_dir()}

    @classmethod
    def open(cls, path: Path, expected_hash: str) -> "Archive":
        try:
            if path.stat().st_size > MAX_ARCHIVE_BYTES:
                raise ArchiveError("the archive is larger than 25 MB")
            data = path.read_bytes()
        except OSError as error:
            raise ArchiveError(f"the archive is not available: {type(error).__name__}") from error
        if f"sha256:{hashlib.sha256(data).hexdigest()}" != expected_hash:
            raise ArchiveError("the archive does not match the hash recorded on delivery")
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as error:
            raise ArchiveError("the delivered file is not a valid ZIP") from error
        validate(z, len(data))
        return cls(z)

    def entries(self) -> list[tuple[str, int]]:
        return [(name, info.file_size) for name, info in self._files.items()]

    def read(self, name: str, max_bytes: int) -> bytes:
        info = self._files.get(name)
        if info is None:
            raise ArchiveError(f"no entry named {name[:200]}")
        if info.file_size > max_bytes:
            raise ArchiveError(f"{name[:200]} is too large to read ({info.file_size} bytes)")
        try:
            with self._zip.open(info) as entry:
                # One byte over the limit: the declared size can lie, the bytes cannot.
                data = entry.read(max_bytes + 1)
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
            raise ArchiveError(f"{name[:200]} cannot be read: {type(error).__name__}") from error
        if len(data) > max_bytes:
            raise ArchiveError(f"{name[:200]} is too large to read")
        return data
