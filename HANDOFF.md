# 粤语学习应用 - 交接文档

## 项目概述

单 HTML 文件的粤语学习网页应用，部署在 Cloudflare Pages。

**线上地址：** https://zhong2.isyou.icu  
**GitHub：** https://github.com/bosschangpeng/xueyy.git  
**分支：** master

## 文件结构

| 文件 | 说明 |
|------|------|
| `index.html` | 主应用（HTML+JS+CSS+99K词典+29K粤拼），~1340行 |
| `_worker.js` | Cloudflare Pages Worker（鉴权+MiniMax TTS代理+预处理），~327行 |

## 核心功能

1. 分句词组展示、点击发音
2. 29K字映射 + 99K词典 + 19K多音字消歧
3. MiniMax TTS 在线发音（Speech-2.8-hd，粤语女声）
4. IndexedDB 音频缓存
5. 分块预处理（每4句一批）

## 当前关键问题：charTime 对齐

### 问题描述

预处理完成后，点击词组/句子播放音频时：
- 要么没声音（playCharRange 返回 false）
- 要么播放的音频与文字不对应（charTime 位置错误）
- 要么回退到离线 TTS

### 已尝试的修复（均未完全解决）

1. **buildTextMapping** — 用双指针将修改后文本位置映射回原文位置
2. **去掉 addSentencePauses** — 直接用原文调 MiniMax，避免时间线错位
3. **songData 失效** — 文本变化后清除旧数据
4. **分块预处理** — 每4句一批，拼接 PCM + charTime

### 数据流

```
前端输入文本
  → splitSentences() 分句
  → 每4句一组 join('') 成 chunk
  → POST /preprocess { text: chunk, voice }
    → Worker: minimaxTts(text) → WAV hex + subtitle
    → Worker: buildCharTime(subtitle) → charTime[]
    → 返回 { char_time, audio_hex, sr, ch, bits, data_off }
  → 前端: hex→bytes, 切出 PCM, 合并所有批次
  → songData = { pcm, charTime, sr, ch, bits, text }
  → playCharRange(startChar, endChar) → 查 charTime → 切 PCM → 播放
```

### renderSentences 词组位置

```javascript
// index.html:1064-1117
function renderSentences(text) {
  const sents = splitSentences(trimmed);
  let globalPos = 0;
  for (const s of sents) {
    const words = segmentText(s);
    for (const w of words) {
      w.start = globalPos + localPos;      // 原文中的起始位置
      w.end = globalPos + localPos + w.text.length;  // 原文中的结束位置
    }
    globalPos += s.length;
  }
}
```

### charTime 构建（Worker）

```javascript
// _worker.js:129-181
// buildCharTime(subtitle, textMapping)
// subtitle 来自 MiniMax，包含 timestamped_words
// 每个 word 有 word_begin, word_end, time_begin, time_end
// 遍历 word 的每个字符，线性插值分配时间
// textMapping 为 null 时直接用原始位置
// 空缺位置用线性插值填充
```

### playCharRange

```javascript
// index.html:334-346
// 遍历 charTime[startChar..endChar-1]
// 取最小 startMs 和最大 endMs
// 切 PCM 播放
// 如果范围内所有 charTime 都是 null/undefined，返回 false
```

## MiniMax API 信息

- **模型：** Speech-2.8-hd
- **声音：** Cantonese_GentleLady（默认）
- **接口：** `POST /v1/t2a_v2?GroupId=...`
- **参数：** speed=0.85, format='wav', subtitle_enable=true, subtitle_type='word'
- **返回：** data.audio（hex WAV）, data.subtitle_file（URL，时Limited）
- **字幕结构：** `[{ text, text_begin, text_end, time_begin, time_end, timestamped_words: [{ word, word_begin, word_end, time_begin, time_end }] }]`

## 可能的修复方向

1. **MiniMax 字幕覆盖率不足** — 长文本只覆盖部分字符（如 401 字只覆盖 187 字），需要确认是 API 限制还是我们处理有问题
2. **PCM 切片与 charTime 的对应关系** — 确认 charTime 的 ms 值是否正确对应 PCM 中的字节偏移
3. **分块间时间偏移** — 多批次拼接时 timeOffsetMs 是否准确（用 PCM 字节计算的时长 vs 字幕实际时长可能有漂移）
4. **直接在前端不做 hex→bytes 转换** — 考虑让 Worker 直接返回 base64 或 ArrayBuffer

## 部署方式

- 推送到 GitHub master 分支 → Cloudflare Pages 自动部署
- Worker 代码在 `_worker.js`，Cloudflare Pages 自动识别

## 环境变量（Worker）

- `ACCESS_PWD` — 管理员密码
- `ALLOWED_CODES` — 邀请码列表（逗号分隔）
- `MINIMAX_API_KEY` — MiniMax API Key
- `MINIMAX_GROUP_ID` — MiniMax Group ID
- `YUE_KV` — KV namespace

## 2026-06-20 TTS 架构更新

当前线上策略已经从“裁单字”收口到“句子/词组稳定优先”：

- `sentence_audio`：MiniMax 预处理整句，用于整句播放、高亮、跟读和诊断。
- `word_audio`：MiniMax 独立生成词组/短语音频，使用 `pronunciation_dict` 约束读音，是当前可靠教学点读主路径。
- `char_context_audio`：单字点击时播放完整上下文载体（优先已知词或自然二字组合），不再从载体里裁出伪单字。
- `char_audio`：仍是完整架构目标，但 MiniMax 已证明不适合作为当前实现路径；后续需要专用单字 TTS、录音素材库或人工复核素材。

重要原则：不要再把 MiniMax subtitle 或载体切片当成干净单字音频来源。单字若走 MiniMax，只能作为完整上下文播放并在调试里标记 `char-context-audio`。在线 TTS 关闭时，离线 TTS 路径保持原逻辑，不依赖预处理教学资产。

## 2026-06-27 CosyVoice 迁移

当前线上在线 TTS 已从 MiniMax 迁移到阿里云百炼 CosyVoice HTTP 非实时语音合成。旧 MiniMax 预处理、subtitle 对齐、整句裁字、载体裁字不再作为当前路线。

Worker 环境变量：

- `DASHSCOPE_API_KEY`：必填，阿里云百炼 DashScope API Key。
- `COSYVOICE_MODEL`：可选，默认 `cosyvoice-v3-flash`。
- `COSYVOICE_VOICE`：可选，默认 `longanhuan_v3`。
- `COSYVOICE_INSTRUCTION`：可选，默认 `请用广东话表达。`。

当前播放规则：

- `/tts`：调用 CosyVoice，返回音频二进制。
- `/debug-tts`：测试 CosyVoice 连通性。
- `/preprocess`：停用，返回 501；前端已隐藏预处理按钮。
- 句子/全文：在线开关开启时优先走 CosyVoice。
- 词组：直接生成词组音频。
- 单字：直接用 CosyVoice 生成独立单字音频；上下文载体仅保留为备用策略。

部署前必须确认 Cloudflare Pages/Worker 已配置 `DASHSCOPE_API_KEY`，否则在线 TTS 会返回 `CosyVoice not configured` 并回退系统语音。
