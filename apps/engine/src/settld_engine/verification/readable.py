# The text of a page as a reader would see it, without scripts and styles (ADR-0010).
import re

_SCRIPT_OR_STYLE = re.compile(r"<(script|style)", re.IGNORECASE)
_CLOSING = {
    "script": re.compile(r"</script[^>]*>", re.IGNORECASE),
    "style": re.compile(r"</style[^>]*>", re.IGNORECASE),
}


def readable_text(body: str) -> str:
    """The page without scripts and styles: code, not content, and most of a page's size.

    Searches the original string, never a lowered copy: lower() can change a string's length, and
    an index from the copy would then cut the wrong part of the page, chosen by the seller.
    Comments and hidden elements stay, because the model has to see what is trying to fool it.
    """
    kept: list[str] = []
    position = 0
    while (opening := _SCRIPT_OR_STYLE.search(body, position)) is not None:
        kept.append(body[position : opening.start()])
        closing = _CLOSING[opening.group(1).lower()].search(body, opening.end())
        if closing is None:
            return "".join(kept)  # never closed: a browser would not show the rest either
        position = closing.end()
    kept.append(body[position:])
    return "".join(kept)
