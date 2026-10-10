---
layout: page
title: Swerve Drive From Scratch
description: A four-module holonomic drive base for my FRC team. The bus topology, timing, state estimation and control loops behind a robot that can translate and rotate independently.
img: assets/img/projects/swerve_card.jpg
date: 2024-01-01
importance: 4
---

<p class="post-date">{{ page.date | date: "%B %Y" }}</p>

<figure class="portrait">
  <video controls playsinline muted loop preload="metadata" poster="{{ '/assets/video/swerve/outdoor_run.jpg' | relative_url }}" src="{{ '/assets/video/swerve/outdoor_run.mp4' | relative_url }}"></video>
  <figcaption>The swerve base driving outside past a line of cones.</figcaption>
</figure>

A holonomic drive can translate in any direction while rotating, independently. In 2024, as a high school student on FRC Team 3482 (Arrowbotics), I built one from scratch for the team's robot: the chassis, the electronics and the drive code. It was the team's first swerve base.

This write-up is about the engineering underneath it. A swerve drive is eight actuators, four absolute angle sensors, a gyro and a camera, all coordinated by one controller on a 20 ms cycle over two CAN buses. Most of the work was making those pieces behave as one machine: deciding where each loop runs, what each bus carries, how stale each measurement is, and what happens when an input goes missing.

## System architecture

<figure>
  <img data-zoomable src="{{ '/assets/img/projects/swerve/architecture.svg' | relative_url }}" alt="System architecture: roboRIO software stack on top, with Spark MAX motor controllers on the roboRIO CAN bus, CTRE sensors on a CANivore bus and Limelight cameras over Ethernet below" />
  <figcaption>Software stack on the roboRIO (top) and the three interfaces that connect it to hardware (bottom).</figcaption>
</figure>

The robot is built from the **command-based** framework: each subsystem owns its hardware, and a command must declare which subsystems it requires. That gives mutual exclusion for free. The drive command, a path follower and a vision-alignment command can't all write to the modules at once, and when one takes over, the previous one is interrupted and its `end()` runs. Every drive-related command stops the modules in `end()`, so no command can leave a wheel running when it's cancelled.

## Power and packaging

The chassis is 27" x 27", built from 25" aluminum bars pocketed to hold the electronics, with a 1/4" aluminum plate. The battery sits low under the shooter to pull the centre of gravity down, which matters for a swerve robot that can accelerate hard in any direction.

The modules sit on a 21.5" square, so each is 0.386 m from the robot's centre. That one number sets the kinematics: a rotation rate of ω adds ω x 0.386 m/s to each wheel's linear speed on top of the translation.

<figure>
  <img data-zoomable src="{{ '/assets/img/projects/swerve/chassis_cad.png' | relative_url }}" alt="CAD render of the swerve chassis with four modules, the PDH and the battery" />
  <figcaption>The chassis in CAD: four modules at the corners, with the power distribution hub and battery inside the frame.</figcaption>
</figure>

Power comes from the battery through a main breaker to a REV Power Distribution Hub, which feeds each module's two Spark MAXes on their own protected channels. A mini power module and a radio power module feed the roboRIO and radio. The heavy battery-to-PDH trunk is kept as short as the layout allows, because that's where the highest currents run and where wire resistance costs the most voltage at the moment the motors need it. I drew the harness as a diagram before cutting any wire.

<figure>
  <img data-zoomable src="{{ '/assets/img/projects/swerve/wiring_diagram.png' | relative_url }}" alt="Wiring diagram: battery, breaker and PDH feeding four swerve modules, each with two Spark MAX controllers, plus the roboRIO, radio power module and radio" />
  <figcaption>The power wiring diagram. Heavy lines are the battery trunk; each module gets two Spark MAX controllers off the PDH.</figcaption>
</figure>

## Two CAN buses and a frame budget

The drivetrain uses two CAN buses, split by vendor. The encoders and gyro are CTRE (CANcoders and a Pigeon 2) and the motor controllers are REV Spark MAXes driving NEOs. So the Spark MAXes sit on the roboRIO's built-in CAN bus, and the CTRE devices sit on a second bus through a CANivore, named `"swerve"` in the code. The sensors the control loop depends on don't compete with the motor traffic.

| Device                              | IDs        | Bus                 |
| ----------------------------------- | ---------- | ------------------- |
| Drive Spark MAXes                   | 3, 5, 7, 9 | roboRIO CAN         |
| Steering Spark MAXes                | 2, 4, 6, 8 | roboRIO CAN         |
| CANcoders (absolute steering angle) | 10 to 13   | CANivore `"swerve"` |
| Pigeon 2 (gyro)                     | 14         | CANivore `"swerve"` |

CAN is a shared medium. At 1 Mbit/s, a frame with a 29-bit ID and 8 data bytes is about 130 bits, or roughly 130 µs on the wire, ignoring bit stuffing. A status frame sent at 100 Hz therefore costs about 1.3% of the bus, whether or not anything reads it. Eight Spark MAXes each broadcast several periodic status frames, so the defaults add up to real utilisation, and the control loop's own commands have to fit around them.

A steering motor doesn't need to report its own position, because the CANcoder provides the angle. So almost all of its status frames are pushed out to very long periods. The periods come from a list of large primes (10 to 33 seconds), so that no two quiet frames ever fall on the same tick and burst onto the bus together:

```java
turningMotor.setPeriodicFramePeriod(PeriodicFrame.kStatus1, PrimeNumbers.getNextPrimeNumber());
turningMotor.setPeriodicFramePeriod(PeriodicFrame.kStatus2, PrimeNumbers.getNextPrimeNumber());
turningMotor.setPeriodicFramePeriod(PeriodicFrame.kStatus3, PrimeNumbers.getNextPrimeNumber());
```

The drive motors keep the frames the odometry needs at a fixed rate, and the rest go quiet the same way.

## Sensors, latency and state estimation

Every measurement on this robot has a source, a bus, an age and a consumer:

| Signal                   | Source                                                                         | Consumer                         |
| ------------------------ | ------------------------------------------------------------------------------ | -------------------------------- |
| Steering angle, absolute | CANcoder (CTRE bus)                                                            | steering PID, odometry           |
| Wheel speed and distance | NEO integrated encoder (REV bus), scaled through gear ratio and wheel diameter | odometry                         |
| Heading                  | Pigeon 2 (CTRE bus)                                                            | field-relative driving, odometry |
| Field position           | Limelight AprilTags (Ethernet)                                                 | pose estimator                   |

The CANcoder is an **absolute** encoder, so the robot knows every wheel angle at power-on with no homing routine. That matters because the NEO's own encoder is relative: after a reboot it knows nothing about wheel orientation, and the CANcoder is what makes the steering loop well-defined from the first cycle.

The signals arrive asynchronously. The CANcoder angle, the NEO velocity and the gyro yaw are each read as the latest cached value from different devices, on different buses, updated at different times, so the controller sees them at slightly different ages. At the speeds this robot drives that skew is small, but it's the reason high-rate odometry on a robot like this is usually done with timestamped, synchronised signals.

Wheel odometry alone drifts, because every slip and wheel-diameter error accumulates. So the pose comes from a Kalman-style estimator that fuses wheel odometry (updated every loop) with AprilTag poses from the Limelight. A camera measurement is only useful if you account for two things:

- **Latency.** The image was captured some tens of milliseconds before the controller sees the result. Each vision measurement is timestamped with the current time minus the camera's reported latency, and the estimator applies it to the pose from when the image was taken, not when it arrived.
- **Trust.** Not every reading deserves equal weight. The code assigns a standard deviation by how much evidence there is, and drops weak readings:

| Evidence from the camera                        | Position std-dev (m) | Heading std-dev |
| ----------------------------------------------- | -------------------: | --------------: |
| Two or more tags                                |                  0.5 |              6° |
| One large tag, within 0.5 m of the current pose |                  1.0 |             12° |
| One far tag, within 0.3 m of the current pose   |                  2.0 |             30° |
| Anything else                                   |             rejected |                 |

The vision heading isn't used at all. The gyro's yaw replaces it, because a single-tag yaw estimate is noisier than an inertial sensor. The "within X m of the current pose" gates are an outlier test: a one-tag reading that disagrees with a good estimate is more likely a bad detection than a real jump.

## Control, with numbers

The path from a stick input to four motor commands has several stages, and each one fixes a specific problem.

<figure class="portrait">
  <video controls playsinline muted loop preload="metadata" poster="{{ '/assets/video/swerve/indoor_driving.jpg' | relative_url }}" src="{{ '/assets/video/swerve/indoor_driving.mp4' | relative_url }}"></video>
  <figcaption>An early bench test, driving the base from a gamepad with the electronics still exposed.</figcaption>
</figure>

1. **Input conditioning.** A deadband removes stick drift. Slew-rate limiters bound the rate of change of the commanded velocity: 1.75 units/s for translation and π units/s for rotation on a normalised -1 to 1 input, so full speed takes about 0.57 s to reach and full rotation about 0.32 s. A fine-control mode scales everything to 25% for precise alignment.
2. **Field-relative transform.** The translation command is rotated by the gyro heading, so "forward" on the stick means away from the driver regardless of which way the robot faces.
3. **Skew correction.** The controller commands the robot in discrete 20 ms steps, but the robot rotates continuously during each step, so the actual path curves away from the commanded one. To first order the sideways drift is v x ω x Δt / 2. At the robot's limits (3 m/s and π rad/s) that's about 9 cm/s. I used the second-order kinematics fix from Team 254, which treats each step as a small pose change and takes its logarithm to get the twist that actually produces that motion.
4. **Inverse kinematics and desaturation.** Chassis velocity becomes four module states. If any wheel is asked to exceed the 5 m/s physical limit, all four are scaled down together so the direction of travel is preserved. The speed limits are set so this rarely triggers: the worst case is full translation plus full rotation at the same corner, 3 + π x 0.386 ≈ 4.2 m/s, which leaves about 0.8 m/s of headroom.
5. **Per-module control.** Each module is optimised so it never rotates more than 90°, runs a PID loop on steering angle, and sets drive speed as a fraction of maximum.

```java
public void setDesiredState(SwerveModuleState state) {
    state = SwerveModuleState.optimize(state, getState().angle);

    double driveMotorSpeed = state.speedMetersPerSecond / SwerveKinematics.PHYSICAL_MAX_MODULE_SPEED;
    double turnMotorSpeed = turningPidController.calculate(getTurningPosition(), state.angle.getRadians());

    driveMotor.set(driveMotorSpeed);
    turningMotor.set(turnMotorSpeed);
}
```

### The steering loop

Each module's steering is a position loop: setpoint is the commanded angle, measurement is the CANcoder, output is a duty cycle from -1 to 1. It's a proportional controller (P = 0.325, no I or D) running on the roboRIO every 20 ms.

Three details matter more than the gain:

- **Wraparound.** +179° and -179° are 2° apart, not 358°. The controller has continuous input over -π to π, so it always takes the short way around. Without it a wheel crossing the 180° boundary would spin almost a full turn the wrong way.
- **Bounded error.** Because the setpoint is optimised to at most 90° away, the error never exceeds π/2 rad, so the loop's largest output is 0.325 x 1.57 ≈ 0.51 duty. The steering motor never saturates, so there's no integrator windup to worry about and no need for an I term.
- **Open-loop drive.** Drive speed is a duty cycle scaled by the target speed, with no velocity feedback. A brushless motor's speed at a given duty cycle scales with battery voltage, so a sag from 12 V to 10.5 V would cost roughly 12% of speed with no way for the controller to notice. This is the main weakness of the design.

## Closing loops on the field

For autonomous, PathPlanner runs a holonomic path follower on the drivetrain, with feedback on translation and rotation (P = 4.5 each), the path mirrored for the red alliance, and the fused pose as its position input.

Two vision-assisted commands handle the cases a pre-planned path can't. One turns the robot until a detected game piece is centred in front of the intake, using the Limelight's horizontal offset as the error for a PID loop (P = 0.6, 5° tolerance). The other aligns to the speaker with AprilTags, scheduling its proportional gain by the size of the starting error, because one gain that's gentle for large errors is too weak for small ones.

## Failure handling

Embedded control code is mostly about what happens when something isn't there:

- **No target.** A vision command refuses to start if it can't see one, and skips a cycle when the camera has no data. A Limelight with no target reads an offset of zero, which would look like a perfect alignment.
- **Interruption.** Every command stops the modules in `end()`, whether it finished or was cancelled.
- **Missing alliance signal.** It's logged as an error and the code falls back to the blue alliance, rather than crashing mid-match or silently using a wrong field transform.
- **Untrusted vision.** Weak AprilTag readings are rejected, as in the table above.

**Stack:** Java, WPILib, REVLib, Phoenix 6, PathPlanner, CAN, AprilTag vision (Limelight), CAD.
