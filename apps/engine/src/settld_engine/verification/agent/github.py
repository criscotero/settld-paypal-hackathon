# Read-only access to a public GitHub repository at one commit (ADR-0019 decision 3A).
#
# Why the REST API and raw files instead of `git clone`: a clone can run hooks, follow
# submodules and pull gigabytes. These are two fixed hosts, GETs only, at a commit Core fixed on
# delivery: nothing the seller pushes later changes what is read, and nothing is executed.
#
# The hosts are constants and owner, name, commit and path are validated before any request, so
# the seller controls no part of where a request goes. SSRF protection is not needed for that.
import re
from urllib.parse import quote

import httpx

from settld_engine.verification.agent.sources import RepoRef

API = "https://api.github.com"
RAW = "https://raw.githubusercontent.com"
TIMEOUT = httpx.Timeout(15.0)
MAX_TREE_BYTES = 8 * 1024 * 1024
_SAFE_PATH = re.compile(r"^[^\x00-\x1f]{1,1000}$")


class RepositoryError(Exception):
    """Why the repository or a file cannot be read, in words safe to show the model."""


class GitHubReader:
    def __init__(
        self, transport: httpx.AsyncBaseTransport | None = None, token: str | None = None
    ) -> None:
        self._transport = transport
        # Settld's own read-only token, only to raise the anonymous rate limit. Never the
        # seller's: Settld does not hold anyone's credentials (ADR-0019 decision 1A).
        self._token = token

    def _client(self) -> httpx.AsyncClient:
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "settld-engine"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return httpx.AsyncClient(
            transport=self._transport or httpx.AsyncHTTPTransport(trust_env=False),
            timeout=TIMEOUT,
            follow_redirects=False,
            headers=headers,
        )

    async def _get(self, url: str, max_bytes: int) -> bytes:
        async with self._client() as client, client.stream("GET", url) as response:
            if response.status_code == 404:
                raise RepositoryError("not found: the repository is private, deleted or moved")
            if response.status_code in (403, 429):
                raise RepositoryError("GitHub is rate limiting the verifier; try again later")
            if response.status_code != 200:
                raise RepositoryError(f"GitHub answered status {response.status_code}")
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise RepositoryError(f"more than {max_bytes} bytes")
                chunks.append(chunk)
            return b"".join(chunks)

    async def tree(self, repo: RepoRef) -> tuple[list[tuple[str, int]], bool]:
        """(path, size) of every file at the commit, and whether GitHub truncated the list."""
        url = f"{API}/repos/{repo.owner}/{repo.name}/git/trees/{repo.commit_sha}?recursive=1"
        try:
            body = httpx.Response(200, content=await self._get(url, MAX_TREE_BYTES)).json()
        except ValueError as error:
            raise RepositoryError("GitHub sent a tree that is not JSON") from error
        files = [
            (item["path"], int(item.get("size", 0)))
            for item in body.get("tree", [])
            if item.get("type") == "blob" and isinstance(item.get("path"), str)
        ]
        return files, bool(body.get("truncated"))

    async def file(self, repo: RepoRef, path: str, max_bytes: int) -> bytes:
        if not _SAFE_PATH.match(path):
            raise RepositoryError("not a valid path")
        url = f"{RAW}/{repo.owner}/{repo.name}/{repo.commit_sha}/{quote(path)}"
        return await self._get(url, max_bytes)
