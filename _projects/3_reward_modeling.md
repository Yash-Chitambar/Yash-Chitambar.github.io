---
layout: page
title: Reward Models for Bimanual Manipulation
description: A causal progress model for a two-arm bottle-placing task, trained on demonstrations and policy failures, and what evaluating it taught me about trusting a reward signal.
img: assets/img/projects/reward_card.jpg
date: 2026-10-01
importance: 1
---

<p class="post-date">{{ page.date | date: "%B %Y" }}</p>

A robot policy is only as good as the data it trains on, and deciding which data is good needs a judge. A reward model is that judge: given a stretch of video and robot state, how much closer to done is the task? If it's trustworthy you can score demonstrations, filter the weak ones, and rank what a policy actually did. If it isn't, you quietly train on the wrong data.

This is an ongoing project. I'm building a reward model for a bimanual task in simulation (two arms putting bottles into a bin) and, just as much, working out how to tell whether it's any good.

## What I'm building

The model, which I call PrimRM, is a causal transformer. At each step it reads frozen visual features from three cameras plus the robot's state, and it only ever sees the past, so it can run live. Its main output is a progress value, trained against targets derived from automatically annotated task primitives (reach, grasp, transport, release). It also has extra heads: one predicts which primitive each arm is in, and one counts the bottles placed, because a single scalar can't carry all of that meaning.

I compare it against published baselines on the same data and splits: WARP-RM (including a causal version I made, since the published model looks about 15 seconds into the future), SARM, and a zero-shot general-purpose reward model.

The latest version is also trained on policy failures. Expert demonstrations almost never show a dropped bottle, so I added labels from policy rollouts, using the simulator's own record of grasps, drops and bin exits.

## How it does

On held-out policy rollouts, with every model restricted to the past:

|                                                   | WARP-RM, causal | PrimRM, causal |
| ------------------------------------------------- | --------------: | -------------: |
| Ranks rollouts by bottles per minute              |            0.54 |       **0.83** |
| Separates grasps that fail from ones that succeed |            0.71 |       **0.91** |
| Live progress error (lower is better)             |            0.41 |       **0.05** |

Against WARP-RM as published, with its 15 seconds of context, PrimRM is better on 10 of 15 scorecard metrics. None of these models trained on the episodes they're scored on.

### Telling a failed grasp from a good one

The figure below takes about two thousand failed and two thousand successful grasp attempts and asks how well each model's speed signal separates them, at every moment around the attempt. A causal WARP-RM only separates them _after_ the attempt (peak 0.84). A causal PrimRM separates them _at_ the attempt (0.92), and with two seconds of context it starts to anticipate it. The published WARP-RM peaks at 0.94, but only because it can see far into the future.

<figure>
  <img data-zoomable src="{{ '/assets/img/projects/reward_failed_grasp_timing.png' | relative_url }}" alt="Left: mean velocity around failed and successful grasp attempts. Right: how well each model separates them at each time offset." />
  <figcaption>Left: average speed signal around 2,087 failed and 2,228 successful grasp attempts. Right: how well each model separates failed from successful at each offset from the attempt.</figcaption>
</figure>

### Watching it on policy rollouts

In each video the robot's three cameras are on the left, and the model outputs sit beside the simulator's ground truth on the right. The black line is true progress (bottles in the bin divided by bottles), and red marks are drops and bottles leaving the bin.

This first one compares three versions of PrimRM on a policy that places only one of six bottles. The two versions trained on demonstrations alone read 0.25 to 0.4 while the bin is empty. The version trained with rollout failures stays near zero and rises when the bottle lands. Average progress error: 0.216, 0.212, and 0.027.

<figure>
  <video controls playsinline preload="metadata" poster="{{ '/assets/video/reward/versions_policy_1_of_6.jpg' | relative_url }}" src="{{ '/assets/video/reward/versions_policy_1_of_6.mp4' | relative_url }}"></video>
  <figcaption>A policy that places 1 of 6 bottles. The light and dark purple lines are demo-only versions; the teal line also trains on rollout failures.</figcaption>
</figure>

This one is a stronger policy that places five of six, with two failed grasps and three drops. Only the rollout-trained version follows the true count through the episode (error 0.142, 0.146, and 0.046). This gain is at the 75th percentile of the rollouts I checked, not the best case.

<figure>
  <video controls playsinline preload="metadata" poster="{{ '/assets/video/reward/versions_policy_5_of_6.jpg' | relative_url }}" src="{{ '/assets/video/reward/versions_policy_5_of_6.mp4' | relative_url }}"></video>
  <figcaption>A policy that places 5 of 6 bottles, with failed grasps and drops along the way.</figcaption>
</figure>

And here is the causal comparison on the failing policy. The published WARP-RM (blue) uses the future; the grey line is the same model made causal; purple is PrimRM. Each model's progress is stretched to 0 to 1 per episode here, so only the shapes compare.

<figure>
  <video controls playsinline preload="metadata" poster="{{ '/assets/video/reward/causal_vs_warp_1_of_6.jpg' | relative_url }}" src="{{ '/assets/video/reward/causal_vs_warp_1_of_6.mp4' | relative_url }}"></video>
  <figcaption>WARP-RM as published, WARP-RM made causal, and PrimRM on a policy that places 1 of 6 bottles.</figcaption>
</figure>

## Lessons so far

### A good-looking correlation can mean almost nothing

My first evaluation compared each model's progress curve with ground-truth progress using rank correlation. Then I added a baseline that knows nothing about the video and just outputs elapsed time divided by episode length. It scored 0.96.

On clean expert demonstrations, progress is close to a straight line in time, so a model can score well by doing nothing clever. After that I stopped treating plain correlation as the headline number and moved to metrics a time-only baseline can't win: how much a model beats the clock by, whether it reacts to _mistakes_, and whether it ranks whole episodes by outcome.

### Audit your oracle too

Ground truth here is the simulator itself: I replay the recorded states and compute true progress and events directly. It's tempting to treat that as unquestionable.

It wasn't. The rule for "a bottle is in the bin" assumed one bin size, but the scenes scale the bin, so bottles on the floor of larger bins went uncounted and made several episodes look unfinished. A bin-scaled rule fixed most of those, and it exposed a second case, a bottle counted before it was ever grasped. Much of what I first read as model error in those episodes was oracle error.

### Leakage hides in the data pipeline

One baseline's published checkpoint and its precomputed columns included episodes I wanted to hold out. Retraining it with an explicit exclusion list meant some of the held-out episodes would otherwise have been trained on. I now treat the split file as the source of truth, validate on a pool carved from training data only, and keep any model trained on rollouts to its own held-out scenes.

### Clean demos can't teach a model about failure

This is the lesson the videos above show. In expert demonstrations mistakes are rare, so a model can look strong while having seen almost nothing about failure. Adding labeled failures from policy rollouts is what stopped the model reading 0.3 progress on an empty bin.

### Progress is partly pace

A normalised progress target is, to a large extent, a duration target. A score that mostly tracks how fast a segment went can be strongly correlated with a time-only score, so using it to curate data risks selecting for speed. Time-warping and reversing training clips was the change that helped most, because it discourages the model from leaning on the clock.

### Curation results depend on everything else

When a reward model is used to filter demonstrations, the downstream policy's performance can move more because of the training recipe (batch size, schedule, how often examples repeat) than because of the filter itself. Retained data and optimiser exposure are different budgets, since a smaller kept set means each example is repeated more. Any fair comparison has to fix the recipe and report both.

## What's next

The real test of a reward model is whether using it makes a better policy. The figure below is one fresh rollout, split into one-second action chunks. Red chunks lead to a failure and green chunks lead to a success. It shows which chunks each selection rule would keep to train a policy: a rule based on WARP-RM's speed, one based on PrimRM, and the simulator's own labels as the reference.

<figure>
  <img data-zoomable src="{{ '/assets/img/projects/reward_onpolicy_selection.svg' | relative_url }}" alt="One rollout over 24 seconds showing which one-second action chunks each selection rule keeps, coloured by whether the chunk leads to a failure or a success" />
  <figcaption>One rollout over 24 seconds. Each row is a selection rule; red marks a chunk that leads to a failure, green one that leads to a success.</figcaption>
</figure>

Next I want to train policies on data selected this way and check whether the better score actually produces better behaviour, using the same training recipe for every arm. I'd also like to separate pace from outcome, so the model can say "this was slow" and "this didn't work" as two different things.

**Stack:** PyTorch, frozen DINOv3 features, transformers, MuJoCo-based simulation, MLflow for run tracking.
