import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AlertTriangle } from "lucide-react";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { db } from "~/db";
import { UserRole, users } from "~/db/schema";
import {
  approveRefundRequest,
  declineRefundRequest,
  getOpenRefundRequests,
} from "~/lib/refund-review.server";
import {
  buildRefundApprovedEmail,
  buildRefundDeclinedEmail,
  sendEmail,
} from "~/lib/refund-emails.server";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";

const actionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundId: z.coerce.number().int(),
    declineReason: z.string(),
  }),
]);

async function requireAdminId(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to review refunds.", {
      status: 401,
    });
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can access this page.", { status: 403 });
  }

  return currentUser.id;
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdminId(request);
  return { refundRequests: getOpenRefundRequests() };
}

export async function action({ request }: Route.ActionArgs) {
  const adminId = await requireAdminId(request);
  const parsed = parseFormData(await request.formData(), actionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  if (parsed.data.intent === "approve") {
    const decision = approveRefundRequest(parsed.data.refundId, adminId);
    sendEmail(buildRefundApprovedEmail(decision));
  } else {
    const decision = declineRefundRequest(
      parsed.data.refundId,
      adminId,
      parsed.data.declineReason
    );
    sendEmail(buildRefundDeclinedEmail(decision));
  }

  return { ok: true };
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { refundRequests } = loaderData;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="mb-1 text-2xl font-bold">Refund requests</h1>
      <p className="mb-6 text-muted-foreground">
        {refundRequests.length === 0
          ? "No refund requests are waiting."
          : `${refundRequests.length} waiting, oldest first. A learner's access is suspended while their request is open.`}
      </p>
      <div className="space-y-4">
        {refundRequests.map((request) => (
          <RefundRequestCard key={request.refundId} request={request} />
        ))}
      </div>
    </div>
  );
}

function RefundRequestCard({
  request,
}: {
  request: Route.ComponentProps["loaderData"]["refundRequests"][number];
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const errors =
    fetcher.data && "errors" in fetcher.data ? fetcher.data.errors : undefined;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">{request.courseTitle}</h2>
            <p className="text-sm text-muted-foreground">
              {request.learnerName} · {formatPrice(request.amountPaid)} · bought{" "}
              {new Date(request.purchasedAt).toLocaleDateString()} · requested{" "}
              {new Date(request.requestedAt).toLocaleDateString()}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">{request.reason}</p>
        <p className="text-sm text-muted-foreground">
          {request.lessonsCompleted} of {request.lessonsTotal} lessons completed
          · {request.hoursWatched} hours watched
        </p>

        <div className="flex flex-wrap items-start gap-6">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="approve" />
            <input type="hidden" name="refundId" value={request.refundId} />
            <Button type="submit" disabled={busy}>
              Approve {formatPrice(request.amountPaid)} refund
            </Button>
          </fetcher.Form>

          <fetcher.Form method="post" className="flex-1 space-y-2">
            <input type="hidden" name="intent" value="decline" />
            <input type="hidden" name="refundId" value={request.refundId} />
            <textarea
              name="declineReason"
              required
              minLength={10}
              maxLength={1000}
              rows={2}
              placeholder="Reason shown to the learner"
              className="w-full rounded-md border bg-background p-2 text-sm"
            />
            {errors && (
              <p className="text-sm text-destructive">
                {Object.values(errors).flat().join(" ")}
              </p>
            )}
            <Button type="submit" variant="outline" disabled={busy}>
              Decline
            </Button>
          </fetcher.Form>
        </div>
      </CardContent>
    </Card>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refund requests.";

  if (isRouteErrorResponse(error)) {
    title = error.status === 403 ? "Access denied" : `Error ${error.status}`;
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
