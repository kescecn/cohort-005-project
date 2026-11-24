import { formatPrice } from "~/lib/utils";

type Decision = {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amountPaid: number;
};

/**
 * There is no mail transport wired up yet, so the built message goes to the
 * server log, the same as the refund request confirmation.
 */
export function sendEmail(email: { to: string; subject: string; body: string }) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}

export function buildRefundApprovedEmail(decision: Decision) {
  return {
    to: decision.learnerEmail,
    subject: `Refund approved — ${decision.courseTitle}`,
    body: [
      `Hi ${decision.learnerName},`,
      "",
      `We have approved your refund request for "${decision.courseTitle}".`,
      `The refund is for ${formatPrice(decision.amountPaid)}, the amount you paid.`,
      "",
      "Your access to the course has ended. We have kept your progress, so if you buy the course again it will be waiting for you.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export function buildRefundDeclinedEmail(
  decision: Decision & { declineReason: string }
) {
  return {
    to: decision.learnerEmail,
    subject: `Refund request declined — ${decision.courseTitle}`,
    body: [
      `Hi ${decision.learnerName},`,
      "",
      `We could not approve your refund request for "${decision.courseTitle}".`,
      "",
      `Reason: ${decision.declineReason}`,
      "",
      "Your access to the course has been restored.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}
