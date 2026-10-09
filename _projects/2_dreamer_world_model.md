---
layout: page
title: Dreamer 4-Style World Model
description: A world model for robot hand manipulation, built from scratch.
importance: 2
---

**Stack:** PyTorch, MuJoCo, Flow Matching, Transformers

- Implemented a Dreamer-style **world model** from scratch: a causal masked **video tokenizer** plus a block-causal **dynamics transformer** (GQA, RoPE, QK-Norm) trained with flow matching at **13M and 40M parameters**.
- Built a **MuJoCo SO-101 simulator** with IK-scripted experts for 4 tasks and collected **311K frames**. The model predicts the next 8 frames with **11x lower error** than baseline and keeps **94% accuracy overall** with 4-step sampling.
- Validated controllability, representation, and rollout fidelity: **reversing input actions** shifts prediction error by 6x, frozen latents decode gripper position, and imagined rollouts match token reconstruction.
