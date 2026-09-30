# -*- coding: utf-8 -*-
"""
PDF Diff 后端服务（零依赖，仅使用 Python 标准库）

功能：
1. 托管前端静态文件（index.html / css / js）
2. POST /api/analyze  接收前端生成的差异报告，流式调用 LLM（OpenAI 兼容接口），
   并以 SSE（Server-Sent Events）把分析结果流式返回给前端
3. GET  /api/config   返回后端配置状态，供前端展示

配置：编辑同目录下 config.json（可从 config.json.example 复制），
或使用环境变量 PDFDIFF_API_KEY / PDFDIFF_BASE_URL / PDFDIFF_MODEL / PDFDIFF_MOCK。

启动：python3 server.py   （默认端口 8765）
"""
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
PORT = int(os.environ.get("PDFDIFF_PORT", "8765"))
MAX_BODY = 300 * 1024  # 请求体上限 300KB
MAX_REPORT = 200_000   # 发送给 LLM 的报告字符上限


def _env(name, default):
    """读取环境变量，空字符串视为未设置（避免空值覆盖 config.json）"""
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def load_config():
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception as e:
            print("[warn] config.json 解析失败:", e)
    return {
        "apiKey": _env("PDFDIFF_API_KEY", cfg.get("apiKey", "")),
        "baseUrl": _env("PDFDIFF_BASE_URL",
                        cfg.get("baseUrl", "https://open.bigmodel.cn/api/paas/v4")),
        "model": _env("PDFDIFF_MODEL", cfg.get("model", "glm-4.7")),
        "mock": str(os.environ.get("PDFDIFF_MOCK", cfg.get("mock", False))).lower()
                in ("1", "true", "yes"),
        # SSL 相关：企业网络存在 TLS 拦截（自签名证书）时，
        # 可将 sslVerify 设为 false，或用 caBundle 指定公司根证书文件
        "sslVerify": str(_env("PDFDIFF_SSL_VERIFY", cfg.get("sslVerify", True))).lower()
                     not in ("0", "false", "no"),
        "caBundle": _env("PDFDIFF_CA_BUNDLE", cfg.get("caBundle", "")),
        "temperature": float(cfg.get("temperature", 0.3)),
        "systemPrompt": cfg.get("systemPrompt",
                                "你是资深的文档审阅专家，负责分析两个版本文档的差异。"
                                "请基于用户提供的 PDF 差异报告，用简体中文进行专业、结构化的分析。"),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    # ---------- 基础工具 ----------
    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sse_headers(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def _sse(self, payload):
        self.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
        self.wfile.flush()

    # ---------- 路由 ----------
    def do_GET(self):
        if self.path == "/api/config":
            cfg = load_config()
            configured = bool(cfg["apiKey"]) or cfg["mock"]
            self._send_json(200, {
                "configured": configured,
                "model": cfg["model"] if not cfg["mock"] else "mock（演示模式）",
                "mock": cfg["mock"],
            })
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/analyze":
            self._send_json(404, {"error": "接口不存在"})
            return

        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_BODY:
            self._send_json(413, {"error": "请求体过大"})
            return
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._send_json(400, {"error": "请求体不是合法 JSON"})
            return

        report = (data.get("report") or "").strip()
        if not report:
            self._send_json(400, {"error": "缺少差异报告内容（report）"})
            return
        if len(report) > MAX_REPORT:
            self._send_json(413, {"error": f"报告过长（{len(report)} 字符），上限 {MAX_REPORT}"})
            return

        cfg = load_config()
        if not cfg["apiKey"] and not cfg["mock"]:
            self._send_json(503, {
                "error": "后端尚未配置 LLM API Key：请编辑 config.json 填入 apiKey 后重启服务",
            })
            return

        print(f"[analyze] report={len(report)} chars, model={cfg['model']}, mock={cfg['mock']}")
        self._sse_headers()
        try:
            if cfg["mock"]:
                self._run_mock()
            else:
                self._run_llm(cfg, report)
            self._sse({"done": True})
        except (BrokenPipeError, ConnectionResetError):
            print("[analyze] 客户端断开连接")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:500]
            print(f"[analyze] LLM API 错误 {e.code}: {detail}")
            self._sse({"error": f"LLM API 返回 {e.code}: {detail}"})
        except Exception as e:  # noqa: BLE001
            print("[analyze] 异常:", e)
            try:
                self._sse({"error": f"服务异常: {e}"})
            except Exception:
                pass

    # ---------- 真实 LLM 调用（OpenAI 兼容流式接口） ----------
    def _ssl_context(self, cfg):
        """按配置构建 SSL 上下文：caBundle 优先，其次 sslVerify 开关"""
        if cfg["caBundle"]:
            return ssl.create_default_context(cafile=cfg["caBundle"])
        if not cfg["sslVerify"]:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            return ctx
        return ssl.create_default_context()

    def _run_llm(self, cfg, report):
        url = cfg["baseUrl"].rstrip("/") + "/chat/completions"
        req = urllib.request.Request(
            url,
            data=json.dumps({
                "model": cfg["model"],
                "stream": True,
                "temperature": cfg["temperature"],
                "messages": [
                    {"role": "system", "content": cfg["systemPrompt"]},
                    {"role": "user", "content": report},
                ],
            }).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {cfg['apiKey']}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=300, context=self._ssl_context(cfg)) as resp:
            buf = b""
            while True:
                chunk = resp.read(1024)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        return
                    try:
                        delta = json.loads(payload)["choices"][0]["delta"].get("content")
                    except Exception:
                        continue
                    if delta:
                        self._sse({"delta": delta})

    # ---------- Mock 演示模式 ----------
    MOCK_TEXT = (
        "## 差异分析报告（Mock 演示模式）\n\n"
        "以下为本地演示模式生成的预置分析，用于验证前后端联调链路。"
        "配置真实 API Key 后即可获得 AI 实时分析。\n\n"
        "### 1. 主要变更总结\n"
        "- 文档版本由 v1.0 升级为 v2.0，整体围绕“登录模块”扩展为“登录 + 注册模块”。\n"
        "- 新增 SSO（OAuth2）单点登录方式，扩充了认证手段。\n"
        "- 密码策略收紧：最小长度由 8 位提高至 10 位。\n"
        "- 性能要求放宽：响应时间由 200ms 调整为 500ms，同时新增 99.9% 可用性要求。\n\n"
        "### 2. 值得关注的变更点\n"
        "- **FR-2 密码长度**：安全增强，但需评估存量用户密码兼容性。\n"
        "- **响应时间 200ms → 500ms**：属于性能指标放宽，建议确认下游是否知情。\n\n"
        "### 3. 潜在风险与不一致\n"
        "- 原 FR-3（会话 30 分钟超时）被删除且未见替代条款，请确认是否有意移除。\n"
        "- 功能需求编号出现跳跃（FR-4 出现而 FR-3 缺失），建议重新编号。\n\n"
        "### 4. 修改建议\n"
        "- 补充会话管理相关条款或在新版本中明确废弃说明。\n"
        "- 为新增的 SSO 登录补充对应的功能需求编号与验收标准。\n"
    )

    def _run_mock(self):
        step = 8
        for i in range(0, len(self.MOCK_TEXT), step):
            self._sse({"delta": self.MOCK_TEXT[i:i + step]})
            time.sleep(0.03)

    def log_message(self, fmt, *args):  # 精简日志
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    cfg = load_config()
    status = "Mock 演示模式" if cfg["mock"] else (
        f"已配置模型 {cfg['model']}" if cfg["apiKey"] else "未配置 API Key")
    print(f"PDF Diff 服务已启动: http://localhost:{PORT}")
    print(f"LLM 状态: {status}")
    if not cfg["apiKey"] and not cfg["mock"]:
        print("提示: 编辑 config.json 填入 apiKey（可参考 config.json.example）")
    server.serve_forever()


if __name__ == "__main__":
    main()
