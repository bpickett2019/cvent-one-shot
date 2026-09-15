"""Normalized blocker classes for serialized benchmark accounting."""
import hashlib
import re


def normalize_blocker(message: str) -> str:
    """Known classes ignore volatile ref/PID/time/URL details; unknowns stay hashed.

    This deliberately avoids fuzzy model classification and does not persist the
    input. Add classes only with regression evidence; keep scope outside the hash.
    """
    if not isinstance(message, str):
        raise ValueError("Failure must be text")
    value = message[:32768].lower()
    classes = (
        ("PERSISTENCE_UNCERTAIN", r"(?:mutation|persistence|write|save).{0,100}(?:uncertain|unknown outcome)|(?:uncertain|unknown).{0,80}(?:mutation|persistence|write|save)"),
        ("LEASE_LOST", r"lease.{0,60}(?:lost|expired|invalid|failed)|(?:lost|expired|invalid).{0,40}lease"),
        ("WRONG_EVENT", r"wrong event|event identity.{0,40}(?:lost|mismatch)|cross.browser|runtime marker.{0,30}(?:changed|mismatch)"),
        ("USER_OWNERSHIP", r"not agent.owned|user.owned|handed to the user|browser.{0,40}ownership"),
        ("AUTH_REQUIRED", r"auth(?:entication)?.{0,30}(?:required|expired|unavailable)|login required|\bsso\b|\bmfa\b"),
        ("PROVIDER_UNAVAILABLE", r"credit balance|insufficient.{0,20}(?:credit|quota)|invalid.{0,10}api.key|authentication_error"),
        ("PROTECTED_ACTION", r"protected.{0,30}(?:action|control|area)|permanent.{0,20}(?:boundary|action)|action blocked"),
        ("STALE_REFERENCE", r"stale.{0,20}ref|ref.{0,30}stale|detached.{0,30}(?:element|node)|element.{0,30}detached"),
        ("AMBIGUOUS_TARGET", r"ambiguous|multiple.{0,20}matches|strict mode violation|not unique"),
        ("CONTROL_NOT_FOUND", r"control_not_found|no.{0,20}(?:control|element).{0,20}found|(?:locator|target|control|element).{0,40}not found|(?:could not|cannot|unable to).{0,20}resolve.{0,30}(?:target|ref|locator)|zero matches"),
        ("READBACK_MISMATCH", r"readback.{0,40}(?:mismatch|does not match|failed)|verify_failed|verification.{0,20}mismatch"),
        ("TIMEOUT", r"timed? out|timeout"),
        ("RATE_LIMIT", r"rate.limit|too many requests|\b429\b"),
    )
    for name, pattern in classes:
        if re.search(pattern, value):
            return name
    # Strip stack frames and volatile request IDs, paths, refs and timestamps.
    value = value.splitlines()[0] if value.splitlines() else "empty"
    value = re.sub(r"https?://\S+", "<url>", value)
    value = re.sub(r"\b[0-9a-f]{8}-[0-9a-f-]{20,}\b", "<id>", value)
    value = re.sub(r"\b\d{4}-\d\d-\d\d[t ][\d:.+z-]+", "<time>", value)
    value = re.sub(r"(?:pid[=: ]*\d+|@[a-z]*\d+\b)", "<volatile>", value)
    value = re.sub(r"\s+", " ", value).strip()
    return "UNKNOWN_" + hashlib.sha256(value.encode()).hexdigest()[:24]
