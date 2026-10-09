---
layout: page
title: Dexterous Hand Manipulation Policy
description: PPO, diffusion, and BC + RL policies for in-hand cube reorientation in MuJoCo.
importance: 1
---

**Stack:** PyTorch, MuJoCo/MFX, JAX, DINOv2, PPO

- Trained PPO, diffusion, and BC + RL policies for dexterous hand cube reorientation in MuJoCo, comparing pure RL against imitation on **800 expert demonstrations**, reaching **91% policy success** with an **asymmetric actor-critic PPO** policy.
- Implemented a **diffusion policy** from scratch with a **FiLM-conditioned 1D U-Net**, EMA, cosine noise scheduling, and receding-horizon control, reaching **80.9% success** with DDIM-accelerated inference.
- Developed a two-camera visuomotor pipeline from **frozen DINOv2 features**, spatial-softmax keypoints, behavior cloning, and RECAP-inspired PPO refinement; KL regularization reduced policy drift.
