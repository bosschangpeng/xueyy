# 粤语学习 App TTS 架构原则

## 最终铁律

不要再试图从自然整句音频中稳定裁出教学级单字。

教学点读音频必须是“生成出来的教学音频”，不是“裁出来的自然语音片段”。

新的音频资产分层：

1. `sentence_audio`：整句自然朗读、跟读、高亮、句内辅助播放。
2. `word_audio`：词组/词卡点读，独立生成，负责清楚和标准。
3. `char_audio`：单字点读，独立生成，负责单字发音、声调训练、多音字对比。
4. `phrase_audio`：短语训练，介于词组和整句之间，后续按需生成。

MiniMax `subtitle_enable: true` + `subtitle_type: word` 只用于时间轴、高亮、QA、辅助区间播放和失败诊断，不再作为“干净裁单字”的主方案。

## 文本层

每条课程内容最终应拆成三份文本：

```ts
interface CantoneseLessonText {
  source_text: string;     // 用户原文、歌词、普通话原句
  display_text: string;    // 前端展示给学习者看的文本
  cantonese_text: string;  // 实际送入粤语 TTS 的文本
  tokens: CantoneseToken[];
}
```

规则：

- 普通口语教学可以把“没说再见”转成“冇讲再见/冇講再見”。
- 歌词、诗句、原文学习不能偷偷强行口语化改写。
- 如果用户看到的文本和听到的文本不同，必须在产品上可解释。

## 读音标准

TTS 不决定读音，AI 也不决定读音。读音标准来自：

1. App 选择的教学口径：默认香港/广府口语粤语。
2. Jyutping 粤拼。
3. 粤语审音配词字库/自建词库。
4. 人工复核。
5. AI 只做候选和辅助检查。

正式课程里的 token 最终都应该有确认过的 Jyutping。

## MiniMax 策略

教学音频优先稳定和清楚，不追求戏剧化自然感：

- 教学音频：优先测试 `speech-2.8-turbo` 或其他稳定 turbo 模型，速度约 `0.80-0.88`，WAV，`language_boost: Chinese,Yue`。
- 自然整句：可测试 `speech-2.8-hd`，速度约 `0.90-1.0`。
- 教学场景不要使用强情绪、笑声、叹气、喘息等标签。

教学请求要按资产类型区分：词组/短语正文只放真正要朗读的粤语文本，读音约束优先放进 `pronunciation_dict`。MiniMax 当前不再承担教学级 `char_audio` 主路径：孤字直发会乱加音节，载体切片会短、错位、不匹配，因此 MiniMax 单字只允许作为完整上下文载体播放，不再从载体里裁出“伪单字”。真正干净的 `char_audio` 需要后续接入专用单字 TTS、录音素材库或人工复核素材。

例如正文保持：

```text
冇講再見
```

读音约束使用：

```json
{
  "pronunciation_dict": {
    "tone": ["冇講再見/(mou5)(gong2)(zoi3)(gin3)"]
  }
}
```

## 播放规则

用户点击字/词时：

```ts
if (word_audio exists) {
  play(word_audio);
} else if (clicked single char and char_context_audio exists) {
  play(full context carrier);
} else if (future verified char_audio exists) {
  play(char_audio);
} else {
  showNeedsReviewOrQueue();
}

// 只允许作为诊断或人工辅助，不作为默认教学点读：
playSentenceSegmentBySubtitleWithPadding();
```

句内 subtitle 区间播放是兜底和诊断工具，不是主要教学音频。

## 队列与缓存

MiniMax 有 RPM 限制，最终不能靠前端实时批量生成。完整架构需要后台队列：

```ts
interface TtsJob {
  id: string;
  type: 'sentence' | 'word' | 'char' | 'phrase';
  text: string;
  jyutping: string;
  model: string;
  voice_id: string;
  speed: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'needs_review';
  retry_count: number;
}
```

缓存 key 必须包含：

```text
asset_type
cantonese_text
jyutping
model
voice_id
speed
pause_strategy
audio_format
language_boost
subtitle_type
```

## QA

每个生成结果最终都要校验：

```ts
interface TtsQaResult {
  ok: boolean;
  audioExists: boolean;
  durationOk: boolean;
  subtitleExists: boolean;
  tokenCountMatch: boolean;
  suspiciousTooShortTokens: string[];
  missingTokens: string[];
  traceId?: string;
}
```

失败处理顺序：

1. 降低 speed。
2. 增加轻微停顿。
3. 切换模型。
4. 拆成更小的 word_audio / char_audio。
5. 标记人工复核。

## 当前 MVP 边界

第一阶段只验证新音频模型是否成立：

1. 保留现有整句预处理，用于句子播放。
2. 新增独立 `word_audio`，并把 MiniMax 单字路线降级为 `char_context_audio`：词组用 `pronunciation_dict` 独立生成；单字点击播放完整上下文载体（优先已知词/自然二字组合，如“望著”“泪眼”），不再裁切成伪单字。调试日志记录 `playbackKind`、`carrierReason`、`targetJyutping` 和队列状态。真正 `char_audio` 暂不由 MiniMax 生成，留给专用引擎/录音素材/人工复核阶段。
3. 本地 IndexedDB 用 hash 缓存教学音频。预处理完成后启动前端队列预热必要字词资产，点击不负责插队生成。歌词重复句子用 chunk 级预处理缓存复用，避免重复请求 API。
4. 词组点击优先播放独立教学音频；单字点击优先播放上下文载体音频，并在 UI/调试中明确标记为上下文，不伪装成纯单字。
5. 单字不再自动回落到整句时间轴切片，避免继续出现短、错位、不匹配的错误样本。
6. 在线 TTS 关闭时，离线 TTS 基础功能保持原逻辑。

后台队列、课程资产表、QA 仪表盘、人工复核、多模型比较放到后续阶段。

## 2026-06-27 CosyVoice 重构原则

MiniMax 相关预处理、subtitle 对齐、整句裁字、载体裁字都不再作为当前实现路线。当前在线 TTS 供应商改为阿里云百炼 CosyVoice HTTP 非实时语音合成：

- Worker `/tts` 调用 `https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`。
- 默认模型：`cosyvoice-v3-flash`。
- 默认音色：`longanhuan_v3`，并传入 `instruction: "请用广东话表达。"`。
- 默认输出：`wav`, `sample_rate: 24000`。
- 前端不再显示预处理按钮；`/preprocess` 在 CosyVoice HTTP 模式下返回停用错误，因为非流式接口不提供可直接复用的字级时间轴。
- 句子播放：直接合成整句/分段文本。
- 词组播放：直接合成词组文本。
- 单字播放：CosyVoice 阶段改为直接生成独立 `char_audio`；上下文载体仅作为后续兜底/对照，不再作为主路径。

新的测试目标不是“从整句裁出单字”，而是验证 CosyVoice 在原文歌词、词组、独立单字三类输入上的粤语读音稳定性。若 CosyVoice 的 `hot_fix.pronunciation` 后续确认可用于粤语/粤拼或可接受的拼音标注，再把项目字典的多音字结果接入热修复层。
