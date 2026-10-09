---
layout: page
title: Dreamer 4-Style World Model
description: An action-conditioned video world model built from scratch, and what it taught me about why good predictors make bad planners.
img: assets/img/projects/dreamer_card.jpg
date: 2026-09-01
importance: 2
---

<p class="post-date">{{ page.date | date: "%B %Y" }}</p>

A policy answers "what should I do?" A world model answers "what happens if I do this?" That second question is more useful: with it you can plan, evaluate a policy without touching the robot, and learn from imagined experience for any reward you like.

I wanted to understand one of these end to end, so I built a Dreamer 4-style world model in PyTorch from scratch and pointed it at four settings: Atari, real SO-101 teleoperation video, a LEAP dexterous hand, and a tabletop simulator I built for the SO-101 arm. Every number below is measured on held-out episodes. The short version is that the model predicts well, is clearly listening to its actions, and still can't be planned through. The interesting part is why.

<figure>
  <img data-zoomable src="{{ '/assets/img/projects/dreamer/pipeline.png' | relative_url }}" alt="Pipeline: episodes, causal tokenizer, frozen latents, dynamics transformer, imagination, CEM planning, evaluation" />
  <figcaption>The pipeline. The tokenizer learns what the world looks like; the dynamics model learns how it moves.</figcaption>
</figure>

## How it works

1. **Tokenizer.** Frames are cut into patches and 0-90% of them are masked. A transformer with full attention inside a frame and causal attention across frames squeezes each frame into a few latent tokens, bounded to [-1, 1] by `tanh`. A lighter decoder rebuilds pixels.
2. **Frozen latents.** The tokenizer is frozen and every episode is encoded once, so the dynamics model never sees a pixel.
3. **Dynamics.** A block-causal transformer (GQA, RoPE, QK-Norm) predicts a latent _velocity_ conditioned on the action and the robot's own sensed state. Flow matching learns the noise-to-data field, and a shortcut-forcing term makes the same network accurate at big steps, so four network evaluations per frame are enough.
4. **Imagination and planning.** Context stays clean, the next frame starts as noise and is integrated to data, then appended. CEM samples action sequences, scores them with a learned reward head, and replans every few steps.

The one invariant I cared about most is causality: no future frame, and no other episode packed into the same batch, may influence an earlier prediction. Both are enforced by tests, not by convention.

## The tokenizer sets the ceiling

<figure>
  <img data-zoomable src="{{ '/assets/img/projects/dreamer/tokenizer_reconstruction.png' | relative_url }}" alt="Tokenizer reconstructions on held-out frames" />
  <figcaption>Held-out reconstructions at 75% masking.</figcaption>
</figure>

Global reconstruction error is dominated by the static background, so the number that matters is the error on pixels that actually move. Getting that metric right took some care: at the default threshold, codec noise marks 72% of a real SO-101 frame as moving. At a threshold of 0.06 it selects the 1.6% of pixels the arm really sweeps.

Almost all of the remaining video error comes from the tokenizer, not the transition model. Measured against a reconstruction floor, dynamics accounts for only 2.2% of the LEAP hand's rollout error and 0.4% of SO-101's.

## Does it predict?

<figure>
  <img data-zoomable src="{{ '/assets/img/projects/dreamer/dynamics_results.png' | relative_url }}" alt="Held-out dynamics results: advantage over persistence by horizon, shortcut steps, and multi-sample error" />
  <figcaption>Held-out dynamics. Left: advantage over repeating the last frame grows with horizon. Middle: the shortcut objective holds at four steps. Right: averaging samples.</figcaption>
</figure>

On the LEAP hand, the model's edge over "just repeat the last frame" grows with the horizon, which is the shape a real transition model should have. Four denoising steps recover nearly all of the eight-step quality.

The right panel is a measurement worth keeping. A flow-matching model _samples_ futures instead of predicting the mean, so squared error against one recorded future charges it for its own sampling variance, while the persistence baseline pays nothing. Averaging eight draws moves the LEAP model from 0.99 to **0.80** of persistence. The hand model was being penalised for being correctly uncertain. The real SO-101 model, by contrast, stays at 1.37: genuinely worse than repeating the last frame.

## What the latents actually contain

<figure>
  <img data-zoomable src="{{ '/assets/img/projects/dreamer/representation_probe.png' | relative_url }}" alt="Linear probe from frozen latents to joint targets" />
  <figcaption>Ridge probes from frozen latents to recorded state, scored on held-out episodes.</figcaption>
</figure>

Reconstruction is only a proxy, so I fit a linear probe from the frozen latents to the recorded state. The SO-101 latent recovers arm joints at R² 0.80 even though it decodes to a visible blur: the information survived and the small decoder is what fails to render it. Doubling the bottleneck width changed nothing. Doubling tokens per frame helped more but still didn't close the gap, so capacity wasn't the constraint. Data was.

The LEAP latent scores just **0.13** on the finger joints. Fingers are small, occlude each other, and hide behind the cube at 128x128 pixels. That's the measured reason the hand is hard: any controller has to choose finger commands from a state that doesn't encode the fingers.

<figure>
  <img data-zoomable src="{{ '/assets/img/projects/dreamer/mujoco_hand_imagination.png' | relative_url }}" alt="LEAP hand: recorded video above, model imagination below" />
  <figcaption>LEAP hand. Recorded video on top, the model's continuation from an eight-frame context below, conditioned on the recorded actions.</figcaption>
</figure>

## A setup where it works

The real SO-101 data is only 32K frames scattered across many different setups. The reference work reports needing roughly 1.5M steps of _one_ setup, which suggests a data-per-setup problem, and that's testable. So I built a self-contained MuJoCo tabletop (SO-101 arm, two small blocks, one fixed camera) and collected a 274K-frame corpus with a scripted IK expert doing reach, push, lift and stack, failures included.

<figure>
  <img data-zoomable src="{{ '/assets/img/projects/dreamer/sim_results.png' | relative_url }}" alt="Simulated tabletop results: prediction, planning with an oracle, and plan-value correlation" />
  <figcaption>Left: one setup is what mattered. Middle: same planner, same budget, with an oracle to isolate the model. Right: the diagnosis.</figcaption>
</figure>

| measurement                 | real SO-101 (32K frames, many setups) | simulated (274K frames, one setup) |
| --------------------------- | ------------------------------------: | ---------------------------------: |
| 8-frame error / persistence |             1.37 (worse than copying) |           **0.089 (11.3x better)** |
| effect of reversing actions |                                     - |                6.0x error increase |
| state probe R²              |                         0.80 (joints) |     0.827 (object + gripper poses) |

Same code, different data, and the model goes from worse than copying the last frame to 11x better. Reversing the action sequence costs it 6x in error, so it really is conditioned on what the robot does.

## Then planning fails, and I can say why

Prediction is not planning. I ran closed-loop CEM in the simulator at matched seeds, with a control that I'd recommend to anyone doing this: `cem_oracle`, the _same planner at the same budget_ rolling out the true simulator instead of the world model. If the oracle succeeds and the world model doesn't, the model is to blame, not the search.

On reach, the oracle scores **1.00** and the learned model scores **0.10**. That's the clean attribution. On lift and stack even the oracle only reaches 0.20, because an 8-step horizon is too short, so I don't read those rows as evidence either way.

The real diagnosis is the correlation between a plan's imagined return and the return it actually earns. It's **negative** on all three tasks (-0.15, -0.36, -0.31). The planner isn't just wrong; it systematically prefers the actions its model is most wrong about. CEM maximises true return plus model error, so the argmax lands where the error is largest. That's why an 11x better one-step predictor doesn't give you a planner: the 11x holds on demonstration trajectories, and CEM's first move is to propose sequences no demonstration ever contained.

### The oracle also caught a bug in my own metric

The oracle's first run reported lift at 0.80 and stack at 0.60, with returns of -2262 and -1271 against the expert's +93. A success rate and a return disagreeing that violently is a bug. A trace showed the planner _batting the block into the air_ to satisfy an instantaneous height check, after which the block left the table and fell to -114 m because nothing ended the episode.

I changed success to require five consecutive steps with the object at rest, made lift require the block still in the gripper, and made leaving the workspace terminate and be penalised. Oracle lift dropped to 0.20.

The lesson is why it was caught at all: my learned-model planner was too weak to find the exploit, so the metric looked sound. An evaluation that has only ever been probed by a mediocre policy hasn't been tested.

## An honest negative on the hand

On `LeapCubeReorient`, the world model plus CEM as the only simulator scores **0.00** success. Holding still earns +26.09 and random actions earn -4.50, so "beats random" would be meaningless here. The planner (-2.27) doesn't clear even the do-nothing bar. Scoring every candidate under common random numbers raised the plan-value correlation from 0.127 to 0.343, which cut the planner's optimism but didn't move task return.

## What I'd take away

Three settings, three different causes, each measured rather than asserted:

- The **LEAP hand** fails on _observability_: the latents don't encode the fingers (probe R² 0.13).
- **Real SO-101** fails on _data per fixed setup_: worse than persistence at 32K scattered frames.
- The **simulated SO-101** succeeds as a predictor but fails as a planning substrate through _model exploitation_.

**Stack:** PyTorch, MuJoCo, flow matching, shortcut forcing, transformers. 38 tests cover causal isolation, packed-batch leakage, action alignment and more.
