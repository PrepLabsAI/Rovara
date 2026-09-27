# Implementation Plan: Stable Performance Tests

**Branch**: `fix/059-stable-timing-tests` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

Replace the absolute `redactArguments` stopwatch limit with five paired measurements at N and 2N,
using the median ratio and a threshold below quadratic growth. Give only the two CDK tests reported
in issue #59 a 30-second timeout through Vitest's test-local options.

## Constitution Check

PASS. This changes test evidence only, retains a meaningful complexity guard, adds no runtime
behavior, and records requirements, plan, tasks, and convergence evidence.
