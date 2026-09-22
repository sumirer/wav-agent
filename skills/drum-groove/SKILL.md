---
name: 鼓组与节奏循环
description: 用合成参数拼出底鼓、军鼓、踩镲与完整节奏 loop
---

# 鼓组与节奏循环

## 单件鼓的配方
- **底鼓 (Kick)**
  - 主体：`sine` + `frequencyCurve: [[0, 140], [0.06, 55], [0.3, 45]]`，让音高在 60ms 内快速下坠，这是"打击感"的来源。
  - 点击：一层极短的 `noise`，`envelope: {attack: 0.001, decay: 0.008, sustain: 0, release: 0.01}`，amplitude 0.25。
  - envelope：`{attack: 0.001, decay: 0.18, sustain: 0.15, release: 0.1}`。
  - 时长 0.35s。
- **军鼓 (Snare)**
  - 噪声主体：`noise` + `highpass: 200` + `envelope: {attack: 0.001, decay: 0.12, sustain: 0, release: 0.08}`，amplitude 0.8。
  - 音高主体：`triangle` 200Hz，decay 0.06s，amplitude 0.35，用来给出"鼓皮"的音高感。
  - 时长 0.3s。
- **踩镲 (Hi-hat)**
  - 闭合：`noise` + `highpass: 6000`，`envelope: {attack: 0.001, decay: 0.035, sustain: 0, release: 0.02}`，时长 0.08s。
  - 开放：把 decay 改成 0.28，时长 0.4s。
- **拍手 (Clap)**：`noise` + `highpass: 1000`，用 3~4 个短脉冲（startTime 错开 8ms）叠加 + 一层长一点的尾巴。

## 节奏 loop 的拼装
- 采样率 44100，`channels: 1`（鼓组单声道更紧凑）。
- 先定 BPM：1 拍 = 60/BPM 秒；1/16 音符 = 15/BPM 秒。
  - 120 BPM 时：1 拍 0.5s，1/16 = 0.125s。
- 每个鼓点都是一个独立 layer，用 `startTime` 定位，用 `endTime` 截断。
- 一个小节的常见骨架（120 BPM，4 拍 = 2s）：
  - 底鼓：0、1.0、1.5s
  - 军鼓：0.5、1.5s
  - 闭合踩镲：每 0.25s 一次（8 个）
- layer 数量会很多，这是正常的；把每个鼓点的 family 参数保持一致（同样配方），只改 startTime。

## 硬性要求
- 打击类音色**必须**有非零 attack 且极短（0.001~0.005s），同时 decay 要短，否则会糊成一团。
- 不要给鼓组加 reverb（除非用户明确要求"大厅鼓组"），会损失冲击力。
- 生成后请说明你用的 BPM 与网格，方便用户要求微调。
