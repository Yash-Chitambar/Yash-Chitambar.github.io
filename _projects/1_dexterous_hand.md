---
layout: page
title: Dexterous Hand Manipulation Policy
description: Four ways to teach a robot hand to reorient a cube, scored by one harness, with the bugs that cost me the most time.
img: assets/img/projects/hand_card.jpg
date: 2026-08-01
importance: 3
---

<p class="post-date">{{ page.date | date: "%B %Y" }}</p>

In-hand reorientation is a good stress test for robot learning. The hand has many joints, contact is brief and discontinuous, and the cube is easy to drop. I wanted to know how far each of the standard approaches gets on the same task, so I trained four policies on cube reorientation in MuJoCo and scored them with a single evaluation harness.

## The setup

The task runs in MuJoCo Playground on the **LEAP hand**: 16 actuated joints (four fingers with four joints each, no wrist), controlled at 20 Hz. The actor sees a 57-dimensional state; the critic gets a 128-dimensional privileged state, so an asymmetric actor-critic is free. Success means the cube's orientation is within 0.1 rad of the goal, after which the goal resamples.

One detail is worth flagging for anyone comparing numbers. Playground has no Shadow Hand, and 0.1 rad is the environment's own threshold, not the 0.4 rad used in the original Shadow Hand work. This is a different and easier hand, so I didn't compare against published numbers.

## Four policies, one harness

| policy            | observation          | what it tests                      |
| ----------------- | -------------------- | ---------------------------------- |
| PPO (state)       | state                | the performance ceiling            |
| Diffusion (state) | state                | can imitation match the RL expert? |
| BC (vision)       | RGB + proprioception | what does plain regression lose?   |
| BC + RL (vision)  | RGB + proprioception | how much does RL recover?          |

The interesting numbers aren't any single success rate. They're the gaps: what multimodal action modelling buys over regression, and how much of the imitation-to-expert deficit RL refinement recovers.

## PPO: the expert

I trained PPO with an asymmetric actor-critic and reached **91% policy success**. That policy then generated **800 expert demonstrations**, which everything downstream learns from.

Three silent failures are worth knowing about on this stack, because none of them raises an error:

- **Truncation is not termination.** The environment auto-resets at 1000 steps, and that's a time limit, not a failure. Treat it as terminal and the value function learns the universe ends every 50 seconds. On this task nearly every episode ends by truncation, so it's most of the signal, not a few percent.
- **Action scaling.** The environment already maps actions from [-1, 1] to the actuator ranges, and those ranges aren't symmetric. Rescale again in a wrapper and you silently halve the reachable joint range, so the policy looks "almost trained" forever.
- **Log-prob reduction.** The Gaussian policy's log-probability has to be summed over the 16 action dimensions, not averaged. Averaging rescales the PPO surrogate by 1/16 and the clip range stops meaning anything.

## Diffusion policy

I implemented the diffusion policy from scratch: a FiLM-conditioned 1D U-Net over action chunks, with EMA weights, cosine noise scheduling and receding-horizon control. With DDIM-accelerated inference it reaches **80.9% success**, about 89% of the PPO expert's 91%.

Two lessons stood out. The training loss tells you almost nothing: noise-prediction error flattens early while the policy is still improving, so only rollout success is informative. And evaluating the EMA weights instead of the live ones is typically worth 10 to 20 points.

## From pixels

For the vision policies I used two cameras with **frozen DINOv2 features** and spatial-softmax keypoints, trained with behaviour cloning. The trap here is proprioception leakage. If the state slice accidentally includes the cube pose, your "vision" policy is really a state policy and looks great for the wrong reason, so it's worth pinning down exactly which indices go in.

## Refining with RL

The last policy takes the behaviour-cloned vision policy and fine-tunes it with PPO plus a KL penalty back to the BC prior, in the style of RECAP. The KL term is what keeps the policy from forgetting what imitation taught it, and the regularisation reduced policy drift.

Two details decide whether this works. The KL is a penalty added to the loss you minimise, and getting the sign backwards pushes the policy _away_ from the prior and collapses success within the first hundred updates. And BC gives you no value function, so the first updates produce garbage advantages that can wreck the initialisation; freezing the actor for a critic warm-up phase fixes it.

**Stack:** PyTorch, MuJoCo/MJX, JAX, DINOv2, PPO.
