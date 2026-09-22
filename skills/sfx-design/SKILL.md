---
name: 音效设计基础
description: 把模糊的自然语言需求拆解成可合成的参数结构，是所有音效类需求的第一步
---

# 音效设计基础

## 拆解方法
任何音效都可以拆成四个维度，先把用户描述映射到这四个维度，再落到具体 layer：

1. **时间形态**：是一次冲击（0.05~0.5s）、一段循环（1~4s）还是长氛围（5s+）。
   - 冲击类：总时长 = 主体 + 尾巴，建议 0.2~0.8s。
   - 循环类：确保首尾电平接近，开启 fadeIn/fadeOut 各 0.005s 防止爆音。
2. **频谱中心**：低频（<200Hz）负责重量感，中频（200~2kHz）负责主体辨识度，高频（>4kHz）负责亮度与空气感。
3. **时间演化**：频率是升、降还是抖动；音量是瞬衰还是慢起。
4. **质感**：干净（纯振荡器）还是有颗粒感（noise + bitcrush + distortion）。

## 标准分层模板
- 主体层：主导听觉识别的振荡器，使用 frequencyCurve 做音高走向。
- 冲击层：极短的 noise 或高频振荡器，envelope 的 decay 设成 0.01~0.05s。
- 尾巴层：低频 sine 或 reverb，负责空间收尾。
- 修饰层：fm 调制或高频点缀，用来增加金属感 / 电子感。

## 常见需求的参数映射
| 需求 | 做法 |
| --- | --- |
| 激光枪 | saw 层 + frequencyCurve 从 1800Hz 快速下扫到 200Hz（0.15s 内），加 bitcrush 8 |
| 爆炸 | pink noise 层 + lowpass 800Hz 扫频 + 低频 sine 60Hz 短促冲击 + reverb decay 0.8 |
| 拾取道具 | triangle 层做两段上行音（如 880 → 1320Hz），envelope decay 0.12s，amplitude 0.6 |
| 成功提示 | 三层叠加 C5-E5-G5（523/659/784Hz），各层 amplitudeCurve 错开 40ms 形成琶音 |
| 失败提示 | 两层 square 从 220Hz 滑到 150Hz，envelope 快速衰减，加 lowpass 1200 |
| 脚步 | noise 层 envelope decay 0.06s + lowpass 1200 + highpass 300 |
| 开关声 | square 脉冲 0.02s + 静音 + 第二个脉冲，中间留 30ms 空隙 |

## 硬性要求
- 一定要设置 `normalize: true`（默认值），并在叠加多层时把单层 amplitude 控制在 0.3~0.7，避免靠归一化强行拉平动态。
- 单次生成的 duration 不要超过 10 秒；更长的内容请提醒用户这是长音频。
- 所有短音都必须有非零的 attack（至少 0.002s）与 release，否则会听到咔哒声。
