"""Read IDM's installed extension archive without executing any extension code."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import zipfile


def inspect_archive(archive: Path, output: Path) -> dict:
    data = archive.read_bytes()
    if len(data) > 2 * 1024 * 1024 or data[:4] != b"Cr24":
        raise ValueError("IDM 扩展包头或大小无效")
    version = struct.unpack_from("<I", data, 4)[0]
    if version == 3:
        offset = 12 + struct.unpack_from("<I", data, 8)[0]
    elif version == 2:
        key, signature = struct.unpack_from("<II", data, 8)
        offset = 16 + key + signature
    else:
        raise ValueError("未支持的 CRX 版本")
    with zipfile.ZipFile(io.BytesIO(data[offset:])) as package:
        manifest = json.loads(package.read("manifest.json"))
        members = []
        for name in ("background.js", "content.js", "document.js"):
            if name not in package.namelist():
                continue
            info = package.getinfo(name)
            if info.file_size > 512 * 1024:
                raise ValueError("扩展源码超过只读预算")
            body = package.read(name)
            text = body.decode("utf-8")
            output.joinpath(name).write_bytes(body)
            probes = {}
            for marker in (
                "connectNative", "com.tonec.idm", "onCreated", "onDeterminingFilename",
                "onBeforeSendHeaders", "onHeadersReceived", "onBeforeRedirect",
                "Content-Disposition", "cookies.getAll", "referrer", "finalUrl",
                "postMessage", "requestBody",
            ):
                position = text.find(marker)
                probes[marker] = None if position < 0 else {
                    "offset": position,
                    "excerpt": text[max(0, position - 80):position + 200],
                }
            members.append({"name": name, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(), "probes": probes})
    return {
        "archiveSha256": hashlib.sha256(data).hexdigest(),
        "archiveBytes": len(data),
        "crxVersion": version,
        "extensionName": manifest.get("name"),
        "extensionVersion": manifest.get("version"),
        "permissions": manifest.get("permissions"),
        "members": members,
        "execution": "未执行扩展或私有宿主",
        "authenticity": "仅绑定已安装包字节，不把版本一致视为CRX签名验证",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    destination = arguments.output.resolve()
    if not destination.is_relative_to(Path.cwd().resolve() / "log"):
        raise ValueError("静态调查原件只能写入项目 log")
    destination.mkdir(parents=True, exist_ok=True)
    report = inspect_archive(arguments.archive, destination)
    destination.joinpath("inspection.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"extensionVersion": report["extensionVersion"], "archiveSha256": report["archiveSha256"], "execution": report["execution"]}, ensure_ascii=False))
