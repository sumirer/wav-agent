---
name: 环境氛围与拟音
description: 雨声、风声、海浪、火焰、机房底噪等循环氛围音，以及脚步声之类的拟音
---

# 环境氛围与拟音

## 氛围音的构造方法
氛围的本质是"有结构的噪声"，不要只丢一段 pure noise，那样听起来像电视雪花。

**三层结构**：
1. **底噪层**：`pink` noise 打底（比 white 更接近真实环境），amplitude 0.35 左右，用低频 `amplitudeCurve` 做缓慢起伏。
2. **特征层**：环境里可辨识的元素。
   - 雨：高频 white noise + highpass 2000，再叠加随机分布的短促 click（多个短 noise layer，用 startTime 错开）。
   - 风：pink noise + lowpass 600，用 `frequencyCurve` 让 lowpass 在 300~900Hz 之间缓慢摆动（用多层不同振幅的 noise 交替实现）。
   - 海浪：低频 pink noise 用 `amplitudeCurve` 做 4 秒周期的涨落，叠加一层 highpass 1500 的 white 表达浪花。
   - 火焰：pink noise + highpass 400 + 随机的短促爆裂（bitcrush 的 noise 层）。
3. **空间层**：`reverb: { decay: 0.7~0.9, mix: 0.3~0.45 }`，这是让氛围"有空间"的关键。

## 拟音（Foley）的要点
- 脚步：noise 层 envelope `{attack: 0.002, decay: 0.05, sustain: 0, release: 0.03}` + lowpass 1200 + highpass 300；不同材质改用不同的 lowpass（木板 2000、草地 900、金属 4000 + bitcrush）。
- 布料摩擦：pink noise + lowpass 2000 + 缓慢 amplitudeCurve，duration 0.4s。
- 开门吱呀：saw 层 + frequencyCurve 在 400~700Hz 之间抖动 + distortion 0.2。

## 循环要求
- 结尾电平必须回到与开头相近的水平，否则循环时会有明显接缝；用 `amplitudeCurve` 手工塑造首尾。
- duration 建议 4~8 秒（单次生成上限 120 秒，但过长会占用用户磁盘）。
- 氛围类请使用 `channels: 2`，并让不同层的 `pan` 不同（例如底噪 pan 0、特征层 pan -0.6、空间层 pan 0.5），立体声宽度会显著提升真实感。

## 硬性要求
- 氛围类的 `normalize: true` 要保留，但把底噪层 amplitude 压低到 0.3~0.4，给偶发元素留出动态余量。
- 不要用纯 sine 做氛围，会听起来像耳鸣。
