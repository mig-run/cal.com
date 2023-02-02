import { NextApiRequest, NextApiResponse } from "next";

import {
  EventLocationType,
  getEventLocationValue,
  LocationObject,
  privacyFilteredLocations,
} from "@calcom/app-store/locations";
import { parseRecurringEvent } from "@calcom/lib";
import prisma, { bookEventTypeSelect } from "@calcom/prisma";
import { customInputSchema, EventTypeMetaDataSchema } from "@calcom/prisma/zod-utils";

import { asStringOrThrow } from "@lib/asStringOrNull";
import { post } from "@lib/core/http/fetch-wrapper";
import { BookingCreateBody, BookingResponse } from "@lib/types/booking";

type Response = {
  message: string | any;
};

async function getEventType(id: string, ctx: { prisma: typeof prisma }) {
  const eventTypeRaw = await ctx.prisma.eventType.findUnique({
    where: {
      id: parseInt(asStringOrThrow(id)),
    },
    select: {
      ...bookEventTypeSelect,
    },
  });

  if (!eventTypeRaw) return null;

  const eventType = {
    ...eventTypeRaw,
    metadata: EventTypeMetaDataSchema.parse(eventTypeRaw.metadata || {}),
    recurringEvent: parseRecurringEvent(eventTypeRaw.recurringEvent),
  };

  return [eventType].map((e) => {
    let locations = eventTypeRaw.locations || [];
    locations = privacyFilteredLocations(locations as LocationObject[]);
    return {
      ...e,
      locations: locations,
      periodStartDate: e.periodStartDate?.toString() ?? null,
      periodEndDate: e.periodEndDate?.toString() ?? null,
      schedulingType: null,
      customInputs: customInputSchema.array().parse(e.customInputs || []),
      users: [],
    };
  })[0];
}

type BookingFormValues = {
  name: string;
  email: string;
  notes?: string;
  locationType: EventLocationType["type"];
  guests?: { email: string }[];
  address?: string;
  attendeeAddress?: string;
  phone?: string;
  hostPhoneNumber?: string; // Maybe come up with a better way to name this to distingish between two types of phone numbers
  customInputs?: {
    [key: string]: string | boolean;
  };
  rescheduleReason?: string;
  smsReminderNumber?: string;
};

const createBooking = async (data: BookingCreateBody) => {
  return await post<BookingCreateBody, BookingResponse>(
    `${process.env.NEXT_PUBLIC_WEBAPP_URL}/api/book/event`,
    data
  );
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Response>): Promise<void> {
  const { eventTypeId, name, email, start, end, notes, timezone, key } = req.query;
  if (key !== process.env.MIGRUN_INTEGRATION_KEY) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const eventType = await getEventType(eventTypeId as string, { prisma });
  if (!eventType) {
    return res.status(404).json({ message: "Event type not found" });
  }
  const locations: LocationObject[] = [{ type: "integrations:daily" }];
  const booking: BookingFormValues = {
    name: name as string,
    email: email as string,
    locationType: "integrations:daily",
    notes: notes as string,
  };
  const data: BookingCreateBody = {
    ...booking,
    start: start as string,
    end: end as string,
    timeZone: timezone as string,
    eventTypeId: parseInt(eventTypeId as string),
    customInputs: [],
    metadata: {},
    language: "en",
    hasHashedBookingLink: false,
    eventTypeSlug: eventType.slug,
    location: getEventLocationValue(locations, {
      type: booking.locationType,
      phone: booking.phone,
      attendeeAddress: booking.attendeeAddress,
    }),
    guests: [],
  };
  return createBooking(data)
    .then((booking) => {
      return res.status(200).json({ message: booking });
    })
    .catch((error) => {
      return res.status(500).json(error);
    });
}
