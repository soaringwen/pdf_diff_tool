# PDF Diff — PDF 差异对比工具

一个纯前端的 PDF 文档差异对比工具。上传两个 PDF 文件，即可可视化查看文本差异，并将差异报告导出为 Markdown，方便发送给大模型（GLM、GPT 等）进行智能分析。

**所有解析与对比均在浏览器本地完成，文件不会上传到任何服务器。**

## 功能特性

- **文件上传**：点击选择或拖拽上传，实时显示文件名、页数、大小、文本提取状态
- **左右对照视图**：双栏对齐展示，删除行红底、新增行绿底、修改行两侧对照
- **合并视图**：类 Git diff 的 `−` / `+` 行样式
- **字符级高亮**：修改行内精确标出变动的字词（中文按字符、英文按词）
- **差异导航**：上一个/下一个差异跳转，支持快捷键，显示进度 `3 / 5`
- **统计信息**：新增 / 删除行数、差异处数；内容一致时提示"完全一致"
- **页码标记**：按 PDF 页分节显示"第 X 页"，便于定位原文
- **忽略空白**：可勾选忽略空白与空行差异
- **导出差异报告**：生成结构化 Markdown 报告，支持一键复制或下载 `.md` 文件

## 快速开始

### 启动

```bash
python3 server.py
# 浏览器访问 http://localhost:8765
```

`server.py` 是零依赖的 Python 后端（仅标准库），同时负责：
- 托管前端页面（无需再单独起静态服务器）
- `POST /api/analyze`：接收前端差异报告，流式调用 LLM，以 SSE 返回分析结果
- `GET /api/config`：返回后端配置状态

> 也可以直接双击 `index.html` 查看页面对比功能，但 AI 分析需要通过 `server.py` 启动。

### 配置 AI 分析（可选）

编辑项目根目录的 `config.json`（可从 `config.json.example` 复制修改）：

```json
{
  "apiKey": "你的 API Key",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "model": "glm-4.7",
  "mock": false,
  "sslVerify": true,
  "caBundle": ""
}
```

| 字段 | 说明 |
|---|---|
| `apiKey` | LLM 服务密钥（智谱 / DeepSeek / OpenAI 等任一兼容服务） |
| `baseUrl` | OpenAI 兼容接口地址，去掉末尾 `/chat/completions` |
| `model` | 模型名，如 `glm-4.7`、`deepseek-chat`、`gpt-4o` |
| `mock` | 设为 `true` 可在不配置 Key 的情况下演示完整链路（返回预置文本） |
| `sslVerify` | 调用 LLM 接口时是否校验 SSL 证书，默认 `true` |
| `caBundle` | 自定义 CA 证书文件路径（PEM 格式），优先级高于 `sslVerify` |

所有字段均可用环境变量覆盖：`PDFDIFF_API_KEY` / `PDFDIFF_BASE_URL` / `PDFDIFF_MODEL` / `PDFDIFF_MOCK` / `PDFDIFF_SSL_VERIFY` / `PDFDIFF_CA_BUNDLE`。修改 `config.json` 后需重启 `server.py` 生效。

**API Key 只保存在后端，永远不会暴露给浏览器。**

### 常见问题排查

**AI 分析报错 `SSL: CERTIFICATE_VERIFY_FAILED ... self-signed certificate in certificate chain`**

这是企业网络中常见的 TLS 拦截导致的：出口代理会用自签名证书替换 LLM 服务的证书。两种解决办法：

1. **快速解决**：在 `config.json` 中设置 `"sslVerify": false`，重启服务（仅建议在可信内网环境使用）
2. **更安全的方式**：向 IT 部门获取公司根证书（PEM 格式），在 `config.json` 中配置 `"caBundle": "/path/to/company-ca.pem"`，重启服务

**AI 分析提示"无法连接后端服务"**

说明页面不是通过 `python3 server.py` 启动的（例如直接双击打开 `index.html`），请改用 `python3 server.py` 启动后访问。

**AI 分析提示"后端尚未配置 LLM API Key"**

编辑 `config.json` 填入 `apiKey` 后重启 `server.py`。

### 使用步骤

1. **上传文件**：在左侧上传"原文件（旧版本）"，右侧上传"对比文件（新版本）"，支持点击选择或拖拽
2. **开始对比**：两个文件就绪后点击"开始对比"按钮
3. **查看差异**：
   - 默认为"左右对照"视图，可切换为"合并视图"
   - 点击工具栏的 `▲` / `▼` 按钮或按 `↑` / `↓` 键在各处差异间跳转
4. **导出报告**：点击工具栏"导出差异报告"，在弹窗中复制全文或下载 `.md` 文件
5. **AI 分析**：点击工具栏"AI 分析"，后端将差异报告发送给大模型，分析结果流式实时显示，可随时停止、复制结果（需按上文完成 `config.json` 配置）

### 导出报告发送给大模型

导出弹窗中默认勾选"附带大模型分析指令（Prompt）"，报告结构如下：

```markdown
# PDF 差异对比报告
## 基本信息
- 原文件（旧版本）：xxx.pdf（3 页）
- 对比结果：新增 7 行、删除 5 行，共 5 处差异

## 差异详情
### 差异 1（第 1 页）
- 被删除/修改前的内容
+ 新增/修改后的内容
  保持不变的上下文行

## 分析指令
请基于上述差异报告完成以下分析：…
```

复制全文后直接粘贴到大模型对话框即可。如果只需要纯差异内容，可取消勾选分析指令。

### 快捷键

| 按键 | 功能 |
|---|---|
| `↓` 或 `N` | 下一个差异 |
| `↑` 或 `Shift+N` | 上一个差异 |
| `Esc` | 关闭导出弹窗 |

## 技术原理

```
PDF 文件 ──pdf.js──▶ 带页码的文本行 ──jsdiff(Myers/LCS)──▶ 差异块
                                                        │
                              ┌─────────────────────────┤
                              ▼                         ▼
                    可视化渲染（双栏/合并）      序列化为 Markdown 报告
                                                        │
                    AI 分析结果 ◀──SSE 流式──后端(server.py)──▶ LLM API
```

1. **文本提取**：`pdf.js` 逐页调用 `getTextContent()`，根据 `hasEOL` 标志还原换行，拆分为 `{ text, page }` 行数组
2. **差异计算**：`jsdiff` 基于最长公共子序列（LCS）按行比对，相邻的删除+新增块合并为"修改"块；修改块内再做字符级（中文）/ 词级（英文）细分 diff，实现行内精确高亮
3. **可视化渲染**：diff 序列展开为对齐的双栏格子或 `−`/`+` 单列；占位格保证左右永远对齐
4. **报告导出**：直接序列化内存中的 diff 块结构（不读 DOM），附带页码、上下文行与预设分析 Prompt

## 项目结构

```
├── index.html            # 页面入口
├── css/style.css         # 界面样式
├── js/app.js             # 提取、diff、渲染与 AI 分析逻辑
├── server.py             # 零依赖后端：静态服务 + LLM 流式代理
├── config.json           # 运行时配置（含密钥，勿提交到仓库）
├── config.json.example   # 配置模板
├── gen_test_pdfs.py      # 测试 PDF 生成脚本（可选）
├── test_old.pdf          # 测试文件：旧版本
└── test_new.pdf          # 测试文件：新版本
```

依赖库通过 CDN 加载：

| 库 | 用途 |
|---|---|
| [pdf.js](https://mozilla.github.io/pdf.js/) 3.11.174 | PDF 解析与文本提取 |
| [jsdiff](https://github.com/kpdecker/jsdiff) 5.2.0 | 行级 / 字符级差异计算 |

## 使用建议与已知限制

- **扫描件无法比对**：图片型 PDF 没有文字层，工具会提示"未提取到文本"，此类文件需先经 OCR 处理
- **排版差异不计入**：工具基于文本内容比对，字体、颜色、图片位置等视觉差异不会体现（可勾选"忽略空白"过滤排版造成的空格/换行噪声）
- **大文件性能**：上百页的 PDF 提取和对比可能需要数秒，请耐心等待加载提示完成
- **隐私安全**：无任何后端，数据不出浏览器；但首次使用需联网加载 CDN 依赖库
