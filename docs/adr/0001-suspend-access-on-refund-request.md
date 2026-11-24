# Suspend Course Access when a Refund Request is raised

Course Access is suspended the moment a learner raises a Refund Request, not when the team approves it. Otherwise the learner could keep watching while the request is under review, and the watch time and 14-day window that made the request eligible would keep changing. Suspension is a check on Open Refund Requests rather than a change to the enrollment, so declining restores access with no data to rebuild. Approval then deletes the enrollment but keeps Progress, so a learner who buys again gets it back.

## Considered options

- **End access on approval.** Rejected: the learner keeps the course for the whole review.
- **End access when the Refund is issued.** Rejected: a Failed Refund would leave the learner with the course for free.
- **Delete the enrollment at request time and re-create it on decline.** Rejected: it loses `enrolledAt` and `completedAt` and needs a restore step.
