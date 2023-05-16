import { BookingStatus, WorkflowReminder } from "@prisma/client";
import { NextApiRequest, NextApiResponse } from "next";

import { getCalendar } from "@calcom/app-store/_utils/getCalendar";
import { DailyLocationType } from "@calcom/app-store/locations";
import { deleteMeeting } from "@calcom/core";
import { FAKE_DAILY_CREDENTIAL } from "@calcom/dailyvideo/lib/VideoApiAdapter";
import dayjs from "@calcom/dayjs";
import { isPrismaObjOrUndefined } from "@calcom/lib";
import { HttpError } from "@calcom/lib/http-error";
import { getTranslation } from "@calcom/lib/server";
import prisma from "@calcom/prisma";
import { schemaBookingCancelParams } from "@calcom/prisma/zod-utils";
import { CalendarEvent } from "@calcom/types/Calendar";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "DELETE") {
    return cancelMigrunBooking(req, res);
  }
  return res.status(404);
}

async function cancelMigrunBooking(req: NextApiRequest, res: NextApiResponse) {
  if (req.query.key !== process.env.MIGRUN_INTEGRATION_KEY) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const query = { ...req.query, id: parseInt(req.query.id as string) };
  const { id, uid, allRemainingBookings, cancellationReason } = schemaBookingCancelParams.parse(query);
  const bookingToDelete = await prisma.booking.findUnique({
    where: {
      id,
      uid,
    },
    select: {
      id: true,
      title: true,
      description: true,
      customInputs: true,
      startTime: true,
      endTime: true,
      attendees: true,
      recurringEventId: true,
      userId: true,
      user: {
        select: {
          id: true,
          credentials: true,
          email: true,
          timeZone: true,
          name: true,
          destinationCalendar: true,
        },
      },
      location: true,
      references: {
        select: {
          uid: true,
          type: true,
          externalCalendarId: true,
          credentialId: true,
        },
      },
      payment: true,
      paid: true,
      eventType: {
        select: {
          recurringEvent: true,
          title: true,
          description: true,
          requiresConfirmation: true,
          price: true,
          currency: true,
          length: true,
          workflows: {
            include: {
              workflow: {
                include: {
                  steps: true,
                },
              },
            },
          },
        },
      },
      uid: true,
      eventTypeId: true,
      destinationCalendar: true,
      smsReminderNumber: true,
      workflowReminders: true,
      scheduledJobs: true,
    },
  });

  if (!bookingToDelete || !bookingToDelete.user) {
    throw new HttpError({ statusCode: 400, message: "Booking not found" });
  }

  if (bookingToDelete.startTime < new Date()) {
    throw new HttpError({ statusCode: 400, message: "Cannot cancel past events" });
  }

  if (!bookingToDelete.userId) {
    throw new HttpError({ statusCode: 400, message: "User not found" });
  }

  const organizer = await prisma.user.findFirstOrThrow({
    where: {
      id: bookingToDelete.userId,
    },
    select: {
      name: true,
      email: true,
      timeZone: true,
      locale: true,
    },
  });

  const attendeesListPromises = bookingToDelete.attendees.map(async (attendee) => {
    return {
      name: attendee.name,
      email: attendee.email,
      timeZone: attendee.timeZone,
      language: {
        translate: await getTranslation(attendee.locale ?? "en", "common"),
        locale: attendee.locale ?? "en",
      },
    };
  });

  const attendeesList = await Promise.all(attendeesListPromises);
  const tOrganizer = await getTranslation(organizer.locale ?? "en", "common");
  const evt: CalendarEvent = {
    title: bookingToDelete?.title,
    type: (bookingToDelete?.eventType?.title as string) || bookingToDelete?.title,
    description: bookingToDelete?.description || "",
    customInputs: isPrismaObjOrUndefined(bookingToDelete.customInputs),
    startTime: bookingToDelete?.startTime ? dayjs(bookingToDelete.startTime).format() : "",
    endTime: bookingToDelete?.endTime ? dayjs(bookingToDelete.endTime).format() : "",
    organizer: {
      email: organizer.email,
      name: organizer.name ?? "Nameless",
      timeZone: organizer.timeZone,
      language: { translate: tOrganizer, locale: organizer.locale ?? "en" },
    },
    attendees: attendeesList,
    uid: bookingToDelete?.uid,
    recurringEvent: undefined,
    location: bookingToDelete?.location,
    destinationCalendar: bookingToDelete?.destinationCalendar || bookingToDelete?.user.destinationCalendar,
    cancellationReason: cancellationReason,
  };
  let updatedBookings: {
    uid: string;
    workflowReminders: WorkflowReminder[];
    scheduledJobs: string[];
    references: {
      type: string;
      credentialId: number | null;
      uid: string;
      externalCalendarId: string | null;
    }[];
    startTime: Date;
    endTime: Date;
  }[] = [];
  // by cancelling first, and blocking whilst doing so; we can ensure a cancel
  // action always succeeds even if subsequent integrations fail cancellation.
  if (bookingToDelete.eventType?.recurringEvent && bookingToDelete.recurringEventId && allRemainingBookings) {
    const recurringEventId = bookingToDelete.recurringEventId;
    // Proceed to mark as cancelled all remaining recurring events instances (greater than or equal to right now)
    await prisma.booking.updateMany({
      where: {
        recurringEventId,
        startTime: {
          gte: new Date(),
        },
      },
      data: {
        status: BookingStatus.CANCELLED,
        cancellationReason: cancellationReason,
      },
    });
    const allUpdatedBookings = await prisma.booking.findMany({
      where: {
        recurringEventId: bookingToDelete.recurringEventId,
        startTime: {
          gte: new Date(),
        },
      },
      select: {
        startTime: true,
        endTime: true,
        references: {
          select: {
            uid: true,
            type: true,
            externalCalendarId: true,
            credentialId: true,
          },
        },
        workflowReminders: true,
        uid: true,
        scheduledJobs: true,
      },
    });
    updatedBookings = updatedBookings.concat(allUpdatedBookings);
  } else {
    const updatedBooking = await prisma.booking.update({
      where: {
        id,
        uid,
      },
      data: {
        status: BookingStatus.CANCELLED,
        cancellationReason: cancellationReason,
      },
      select: {
        startTime: true,
        endTime: true,
        references: {
          select: {
            uid: true,
            type: true,
            externalCalendarId: true,
            credentialId: true,
          },
        },
        workflowReminders: true,
        uid: true,
        scheduledJobs: true,
      },
    });
    updatedBookings.push(updatedBooking);
  }
  /** TODO: Remove this without breaking functionality */
  if (bookingToDelete.location === DailyLocationType) {
    bookingToDelete.user.credentials.push(FAKE_DAILY_CREDENTIAL);
  }

  const apiDeletes = [];

  const bookingCalendarReference = bookingToDelete.references.find((reference) =>
    reference.type.includes("_calendar")
  );

  if (bookingCalendarReference) {
    const { credentialId, uid, externalCalendarId } = bookingCalendarReference;
    // If the booking calendar reference contains a credentialId
    if (credentialId) {
      // Find the correct calendar credential under user credentials
      const calendarCredential = bookingToDelete.user.credentials.find(
        (credential) => credential.id === credentialId
      );
      if (calendarCredential) {
        const calendar = getCalendar(calendarCredential);
        if (
          bookingToDelete.eventType?.recurringEvent &&
          bookingToDelete.recurringEventId &&
          allRemainingBookings
        ) {
          bookingToDelete.user.credentials
            .filter((credential) => credential.type.endsWith("_calendar"))
            .forEach(async (credential) => {
              const calendar = getCalendar(credential);
              for (const updBooking of updatedBookings) {
                const bookingRef = updBooking.references.find((ref) => ref.type.includes("_calendar"));
                if (bookingRef) {
                  const { uid, externalCalendarId } = bookingRef;
                  const deletedEvent = await calendar?.deleteEvent(uid, evt, externalCalendarId);
                  apiDeletes.push(deletedEvent);
                }
              }
            });
        } else {
          apiDeletes.push(calendar?.deleteEvent(uid, evt, externalCalendarId) as Promise<unknown>);
        }
      }
    } else {
      // For bookings made before the refactor we go through the old behaviour of running through each calendar credential
      bookingToDelete.user.credentials
        .filter((credential) => credential.type.endsWith("_calendar"))
        .forEach((credential) => {
          const calendar = getCalendar(credential);
          apiDeletes.push(calendar?.deleteEvent(uid, evt, externalCalendarId) as Promise<unknown>);
        });
    }
  }
  const bookingVideoReference = bookingToDelete.references.find((reference) =>
    reference.type.includes("_video")
  );

  // If the video reference has a credentialId find the specific credential
  if (bookingVideoReference && bookingVideoReference.credentialId) {
    const { credentialId, uid } = bookingVideoReference;
    if (credentialId) {
      const videoCredential = bookingToDelete.user.credentials.find(
        (credential) => credential.id === credentialId
      );

      if (videoCredential) {
        apiDeletes.push(deleteMeeting(videoCredential, uid));
      }
    }
    // For bookings made before this refactor we go through the old behaviour of running through each video credential
  } else {
    bookingToDelete.user.credentials
      .filter((credential) => credential.type.endsWith("_video"))
      .forEach((credential) => {
        apiDeletes.push(deleteMeeting(credential, bookingToDelete.uid));
      });
  }

  const attendeeDeletes = prisma.attendee.deleteMany({
    where: {
      bookingId: bookingToDelete.id,
    },
  });

  const bookingReferenceDeletes = prisma.bookingReference.deleteMany({
    where: {
      bookingId: bookingToDelete.id,
    },
  });
  const prismaPromises: Promise<unknown>[] = [attendeeDeletes, bookingReferenceDeletes];

  await Promise.all(prismaPromises.concat(apiDeletes));
  return res.status(200).json({ message: "Booking deleted" });
}
