import { and, asc, count, eq, sql } from "drizzle-orm";
import { data } from "react-router";
import { db } from "~/db";
import {
  courses,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  refunds,
  RefundStatus,
  users,
  videoWatchEvents,
} from "~/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function findOpenRefundRequest(tx: Tx, refundId: number) {
  const refund = tx.select().from(refunds).where(eq(refunds.id, refundId)).get();

  if (!refund) {
    throw data("Refund request not found.", { status: 404 });
  }

  if (refund.status !== RefundStatus.Open) {
    throw data("This refund request has already been decided.", {
      status: 409,
    });
  }

  return refund;
}

function describeDecision(tx: Tx, purchaseId: number) {
  return tx
    .select({
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
      amountPaid: purchases.amountPaid,
    })
    .from(purchases)
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.id, purchaseId))
    .get()!;
}

/**
 * Approves an Open Refund Request for the full amount the learner paid and
 * ends their Course Access. Their Progress is kept.
 */
export function approveRefundRequest(refundId: number, adminId: number) {
  return db.transaction((tx) => {
    const refund = findOpenRefundRequest(tx, refundId);
    const purchase = tx
      .select()
      .from(purchases)
      .where(eq(purchases.id, refund.purchaseId))
      .get()!;

    tx.update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: purchase.amountPaid,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: adminId,
      })
      .where(eq(refunds.id, refundId))
      .run();

    tx.delete(enrollments)
      .where(
        and(
          eq(enrollments.userId, purchase.userId),
          eq(enrollments.courseId, purchase.courseId)
        )
      )
      .run();

    return describeDecision(tx, purchase.id);
  });
}

const DECLINE_REASON_MIN = 10;
const DECLINE_REASON_MAX = 1000;

/**
 * Declines an Open Refund Request. The Decline Reason is shown to the learner,
 * and their Course Access comes back because the request is no longer open.
 */
export function declineRefundRequest(
  refundId: number,
  adminId: number,
  declineReason: string
) {
  const reason = declineReason.trim();

  if (reason.length < DECLINE_REASON_MIN || reason.length > DECLINE_REASON_MAX) {
    throw data(
      `The decline reason must be ${DECLINE_REASON_MIN} to ${DECLINE_REASON_MAX} characters.`,
      { status: 400 }
    );
  }

  return db.transaction((tx) => {
    const refund = findOpenRefundRequest(tx, refundId);

    tx.update(refunds)
      .set({
        status: RefundStatus.Declined,
        declineReason: reason,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: adminId,
      })
      .where(eq(refunds.id, refundId))
      .run();

    return { ...describeDecision(tx, refund.purchaseId), declineReason: reason };
  });
}

function countLessons(courseId: number) {
  return (
    db
      .select({ total: count() })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(eq(modules.courseId, courseId))
      .get()?.total ?? 0
  );
}

function countCompletedLessons(userId: number, courseId: number) {
  return (
    db
      .select({ completed: count() })
      .from(lessonProgress)
      .innerJoin(lessons, eq(lessonProgress.lessonId, lessons.id))
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(
        and(
          eq(lessonProgress.userId, userId),
          eq(modules.courseId, courseId),
          eq(lessonProgress.status, LessonProgressStatus.Completed)
        )
      )
      .get()?.completed ?? 0
  );
}

// The furthest point reached in each lesson, summed — the same measure the
// learner's request is checked against.
function hoursWatched(userId: number, courseId: number) {
  const furthestPerLesson = db
    .select({ furthest: sql<number>`max(${videoWatchEvents.positionSeconds})` })
    .from(videoWatchEvents)
    .innerJoin(lessons, eq(videoWatchEvents.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(
      and(eq(videoWatchEvents.userId, userId), eq(modules.courseId, courseId))
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  const seconds = furthestPerLesson.reduce((sum, row) => sum + row.furthest, 0);
  return Math.round((seconds / 3600) * 100) / 100;
}

/**
 * Every Open Refund Request, oldest first, with how far the learner got.
 */
export function getOpenRefundRequests() {
  const rows = db
    .select({
      refundId: refunds.id,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      learnerId: users.id,
      learnerName: users.name,
      courseId: courses.id,
      courseTitle: courses.title,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, RefundStatus.Open))
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all();

  return rows.map((row) => ({
    ...row,
    lessonsCompleted: countCompletedLessons(row.learnerId, row.courseId),
    lessonsTotal: countLessons(row.courseId),
    hoursWatched: hoursWatched(row.learnerId, row.courseId),
  }));
}
