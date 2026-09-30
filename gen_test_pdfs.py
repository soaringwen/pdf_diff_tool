# -*- coding: utf-8 -*-
"""生成两个用于测试的 PDF（旧版 / 新版），内容包含 新增、删除、修改 的差异行"""
import zlib


def make_pdf(lines, path):
    content = "BT /F1 12 Tf 14 TL 72 740 Td\n"
    for i, ln in enumerate(lines):
        if i > 0:
            content += "T*\n"
        content += f"({ln}) Tj\n"
    content += "ET"
    data = zlib.compress(content.encode("latin-1"))

    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>")
    objs.append(b"<< /Length " + str(len(data)).encode() + b" /Filter /FlateDecode >>\nstream\n" + data + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = b"%PDF-1.4\n"
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {len(objs)+1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\n"
            f"startxref\n{xref_pos}\n%%EOF").encode()
    with open(path, "wb") as f:
        f.write(out)
    print("written:", path)


old_lines = [
    "Project Requirement Specification v1.0",
    "1. Overview",
    "This document describes the login module.",
    "The system supports email and password login.",
    "2. Functional Requirements",
    "FR-1: User can login with email and password.",
    "FR-2: Password must be at least 8 characters.",
    "FR-3: Session expires after 30 minutes.",
    "3. Non-Functional Requirements",
    "Response time must be under 200 ms.",
]

new_lines = [
    "Project Requirement Specification v2.0",
    "1. Overview",
    "This document describes the login and register modules.",
    "The system supports email and password login.",
    "The system also supports SSO login via OAuth2.",
    "2. Functional Requirements",
    "FR-1: User can login with email and password.",
    "FR-2: Password must be at least 10 characters.",
    "FR-4: Users can reset password via email link.",
    "3. Non-Functional Requirements",
    "Response time must be under 500 ms.",
    "Availability must be 99.9 percent.",
]

make_pdf(old_lines, "test_old.pdf")
make_pdf(new_lines, "test_new.pdf")
