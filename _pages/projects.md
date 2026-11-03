---
layout: page
title: projects
permalink: /projects/
description: Robot learning, world models, and the systems around them.
nav: true
nav_order: 2
index: "02"
scene: robot-cube
scene_label: in-hand manipulation
---

<div class="project-list">
{% assign sorted_projects = site.projects | sort: "date" | reverse %}
{% for project in sorted_projects %}
  {% include projects.liquid %}
{% endfor %}
</div>
