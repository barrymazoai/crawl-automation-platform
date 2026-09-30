"""One offline PDF operation per process. No HTTP, OCR, queue or database client."""
import hashlib
from contextlib import closing
import json
import math
import os
from pathlib import Path
import re
import stat
import sys

POLICY = json.loads((Path(__file__).resolve().parent.parent / "policy.json").read_text())


class Failure(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def packed(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def checked_input(i):
    common = {"schemaVersion", "requestId", "observationId", "operationId", "brandId", "sourceId", "listingId", "variantId",
              "module", "implementationVersion", "policyVersion", "configFingerprint", "inputFingerprint", "pdf"}
    operation = i.get("module")
    extra = {"pdf.inspect": set(), "pdf.text": {"pageIndex"}, "pdf.render": {"pageIndex", "scale"}}
    if operation not in extra or set(i) != common | extra[operation] or i["schemaVersion"] != 1:
        raise Failure("PDF.INVALID_INPUT")
    for field in ("requestId", "observationId", "operationId", "brandId", "sourceId", "listingId"):
        if not isinstance(i[field], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,119}", i[field]):
            raise Failure("PDF.INVALID_INPUT")
    if i["variantId"] is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,119}", i["variantId"]):
        raise Failure("PDF.INVALID_INPUT")
    f = i["pdf"]
    if f["kind"] != "source-pdf" or f["mediaType"] != "application/pdf" or any(f[k] != i[k] for k in ("observationId", "sourceId", "listingId", "variantId")):
        raise Failure("PDF.INVALID_INPUT")
    if type(f["byteSize"]) is not int or not 0 < f["byteSize"] <= POLICY["maxInputBytes"]:
        raise Failure("PDF.INPUT_INTEGRITY")
    if operation != "pdf.inspect" and (type(i["pageIndex"]) is not int or not 0 <= i["pageIndex"] < POLICY["maxPages"]):
        raise Failure("PDF.PAGE_RANGE")
    if operation == "pdf.render" and (type(i["scale"]) not in (int, float) or not 0.25 <= i["scale"] <= 4):
        raise Failure("PDF.DIMENSIONS")
    if i["implementationVersion"] != "1" or i["policyVersion"] != "1" or i["configFingerprint"] != sha(packed(POLICY)):
        raise Failure("PDF.ENGINE_MISMATCH")
    material = ["v3:pdf:1", i["schemaVersion"], i["requestId"], i["observationId"], i["operationId"], i["brandId"], i["sourceId"], i["listingId"], i["variantId"],
                operation, i["implementationVersion"], i["policyVersion"], i["configFingerprint"], f["artifactId"], f["sha256"], f["byteSize"],
                f["producer"]["operationId"], f["producer"]["module"], f["producer"]["implementationVersion"], i.get("pageIndex"), i.get("scale")]
    if sha(packed(material)) != i["inputFingerprint"]:
        raise Failure("PDF.INVALID_INPUT")
    return i


def limits():
    hard_memory = False
    cpu = False
    if os.name == "posix":
        import resource
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (POLICY["cpuSeconds"], POLICY["cpuSeconds"] + 1))
        resource.setrlimit(resource.RLIMIT_FSIZE, (POLICY["maxOutputBytes"], POLICY["maxOutputBytes"]))
        cpu = True
        # RLIMIT_AS is not a reliable resident-memory limit on macOS/Windows.
        if sys.platform.startswith("linux"):
            resource.setrlimit(resource.RLIMIT_AS, (POLICY["linuxAddressSpaceBytes"], POLICY["linuxAddressSpaceBytes"]))
            hard_memory = True
    return {"pid": os.getpid(), "platform": sys.platform, "hardAddressSpaceLimit": hard_memory, "cpuLimit": cpu}


def sync_dir():
    if os.name == "posix":
        fd = os.open(".", os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def write_json(path, value):
    data = packed(value)
    if len(data) > POLICY["maxOutputBytes"]:
        raise Failure("PDF.OUTPUT_LIMIT")
    with open(path, "xb") as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())


def geometry(doc, index):
    width, height = doc.get_page_size(index)
    if not all(math.isfinite(v) and 0 < v <= POLICY["maxPagePoints"] for v in (width, height)):
        raise Failure("PDF.DIMENSIONS")
    return {"pageIndex": index, "widthPoints": width, "heightPoints": height}


def main():
    os.umask(0o077)
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise Failure("PDF.INVALID_INPUT")
    i = checked_input(json.loads(raw))
    process = limits()
    import pypdfium2 as pdfium
    from PIL import __version__ as pillow_version
    engine = {"pypdfium2": pdfium.PYPDFIUM_INFO.version, "pdfium": pdfium.PDFIUM_INFO.version, "pillow": pillow_version}
    if any(engine[k] != POLICY[k] for k in engine) or pdfium.PDFIUM_INFO.flags:
        raise Failure("PDF.ENGINE_MISMATCH")
    fd = os.open("source.pdf", os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != i["pdf"]["byteSize"]:
            raise Failure("PDF.INPUT_INTEGRITY")
        data = source.read(POLICY["maxInputBytes"] + 1)
    if len(data) != i["pdf"]["byteSize"] or sha(data) != i["pdf"]["sha256"]:
        raise Failure("PDF.INPUT_INTEGRITY")
    try:
        doc = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as error:
        raise Failure("PDF.ENCRYPTED" if error.err_code == pdfium.raw.FPDF_ERR_PASSWORD else "PDF.BAD_FILE") from None
    width = height = None
    try:
        if pdfium.raw.FPDF_GetSecurityHandlerRevision(doc.raw) >= 0:
            raise Failure("PDF.ENCRYPTED")
        count = len(doc)
        if not 0 < count <= POLICY["maxPages"]:
            raise Failure("PDF.PAGE_LIMIT")
        index = i.get("pageIndex")
        if index is not None and index >= count:
            raise Failure("PDF.PAGE_RANGE")
        if i["module"] == "pdf.inspect":
            result = {"kind": "inspect", "pageCount": count, "pages": [geometry(doc, n) for n in range(count)]}
            filename = "output.json"
            write_json(filename, result)
        else:
            geo = geometry(doc, index)
            with closing(doc.get_page(index)) as page:
                if i["module"] == "pdf.text":
                    with closing(page.get_textpage()) as textpage:
                        if textpage.count_chars() > POLICY["maxTextChars"]:
                            raise Failure("PDF.TEXT_LIMIT")
                        text = textpage.get_text_bounded(errors="strict")
                    if len(text) > POLICY["maxTextChars"] or len(text.encode("utf-8")) > POLICY["maxTextBytes"]:
                        raise Failure("PDF.TEXT_LIMIT")
                    filename = "output.json"
                    write_json(filename, {"kind": "text", "pageIndex": index, "text": text, "hasText": bool(text.strip(" \t\r\n\f\v\u00a0"))})
                else:
                    width, height = math.ceil(geo["widthPoints"] * i["scale"]), math.ceil(geo["heightPoints"] * i["scale"])
                    if max(width, height) > POLICY["maxSidePixels"] or width * height > POLICY["maxPixels"]:
                        raise Failure("PDF.DIMENSIONS")
                    filename = "output.png"
                    with closing(page.render(scale=i["scale"], may_draw_forms=False, draw_annots=False, limit_image_cache=True)) as bitmap:
                        if bitmap.width != width or bitmap.height != height:
                            raise Failure("PDF.DIMENSIONS")
                        image = bitmap.to_pil()
                        try:
                            with open(filename, "xb") as out:
                                image.save(out, format="PNG")
                                out.flush()
                                os.fsync(out.fileno())
                        finally:
                            image.close()
    except pdfium.PdfiumError:
        raise Failure("PDF.BAD_FILE") from None
    finally:
        doc.close()
    size = os.stat(filename).st_size
    if not 0 < size <= POLICY["maxOutputBytes"]:
        raise Failure("PDF.OUTPUT_LIMIT")
    with open(filename, "rb") as output:
        digest = hashlib.file_digest(output, "sha256").hexdigest()
    manifest = {"protocolVersion": 1, "operationId": i["operationId"], "inputFingerprint": i["inputFingerprint"], "sourceSha256": i["pdf"]["sha256"],
                "module": i["module"], "pageIndex": i.get("pageIndex"), "scale": i.get("scale"), "filename": filename, "sha256": digest, "byteSize": size,
                "width": width, "height": height, "engine": engine, "process": process, "complete": True}
    write_json(".complete.pending", manifest)
    os.link(".complete.pending", "complete.json")
    os.unlink(".complete.pending")
    sync_dir()
    print(json.dumps({"protocolVersion": 1, "status": "completed"}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Failure as error:
        print(json.dumps({"protocolVersion": 1, "status": "failed", "code": error.code}), flush=True)
        sys.exit(2)
    except MemoryError:
        print(json.dumps({"protocolVersion": 1, "status": "failed", "code": "PDF.RESOURCE_LIMIT"}), flush=True)
        sys.exit(2)
    except Exception:
        # Never print file paths, native exception messages, PDF content or credentials.
        print(json.dumps({"protocolVersion": 1, "status": "failed", "code": "PDF.PROCESS_FAILED"}), flush=True)
        sys.exit(2)
