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

教学请求正文只放真正要朗读的粤语文本，读音约束优先放进 `pronunciation_dict`，避免模型把括号里的粤拼当成额外内容朗读。

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
if (char_audio or word_audio exists) {
  play(teaching_asset);
} else {
  generateOrQueueTeachingAsset();
}

// 只有作为兜底：
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
2. 新增独立 `char_audio` / `word_audio`，有粤拼就用 `pronunciation_dict` 固定读音。
3. 本地 IndexedDB 用 hash 缓存教学音频。
4. 字/词点击优先播放独立教学音频。
5. 只有教学音频失败时，才用整句时间轴区间兜底。
6. 在线 TTS 关闭时，离线 TTS 基础功能保持原逻辑。

后台队列、课程资产表、QA 仪表盘、人工复核、多模型比较放到后续阶段。
