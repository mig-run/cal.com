import { EventType, SchedulingType } from "@prisma/client";
import MarkdownIt from "markdown-it";
import { GetStaticPaths, GetStaticPropsContext } from "next";
import { useState } from "react";
import { z } from "zod";

import { LocationObject, privacyFilteredLocations } from "@calcom/app-store/locations";
import { getAggregateWorkingHours } from "@calcom/core/getAggregateWorkingHours";
import { CurrentSeats, getUserAvailability } from "@calcom/core/getUserAvailability";
import dayjs, { Dayjs } from "@calcom/dayjs";
import { IS_TEAM_BILLING_ENABLED, WEBAPP_URL } from "@calcom/lib/constants";
import { getDefaultEvent, getGroupName, getUsernameList } from "@calcom/lib/defaultEvents";
import isTimeOutOfBounds from "@calcom/lib/isOutOfBounds";
import { parseRecurringEvent } from "@calcom/lib/isRecurringEvent";
import logger from "@calcom/lib/logger";
import notEmpty from "@calcom/lib/notEmpty";
import getTimeSlots from "@calcom/lib/slots";
import { detectBrowserTimeFormat, TimeFormat } from "@calcom/lib/timeFormat";
import prisma, { availabilityUserSelect } from "@calcom/prisma";
import { User } from "@calcom/prisma/client";
import { EventTypeMetaDataSchema, teamMetadataSchema } from "@calcom/prisma/zod-utils";
import { trpc } from "@calcom/trpc/react";
import { EventBusyDate } from "@calcom/types/Calendar";

import { isBrandingHidden } from "@lib/isBrandingHidden";
import { inferSSRProps } from "@lib/types/inferSSRProps";
import { EmbedProps } from "@lib/withEmbedSsr";

import { SlotPicker } from "@components/booking/pages/AvailabilityPage";

import { TRPCError } from "@trpc/server";

// import trpc from "../../api/trpc/[trpc]";

export type AvailabilityPageProps = inferSSRProps<typeof getStaticProps> & EmbedProps;

const getScheduleSchema = z
  .object({
    // startTime ISOString
    startTime: z.string(),
    // endTime ISOString
    endTime: z.string(),
    // Event type ID
    eventTypeId: z.number().int().optional(),
    // Event type slug
    eventTypeSlug: z.string(),
    // invitee timezone
    timeZone: z.string().optional(),
    // or list of users (for dynamic events)
    usernameList: z.array(z.string()).optional(),
    debug: z.boolean().optional(),
    // to handle event types with multiple duration options
    duration: z
      .string()
      .optional()
      .transform((val) => val && parseInt(val)),
  })
  .refine(
    (data) => !!data.eventTypeId || !!data.usernameList,
    "Either usernameList or eventTypeId should be filled in."
  );

async function getEventType(ctx: { prisma: typeof prisma }, input: z.infer<typeof getScheduleSchema>) {
  const eventType = await ctx.prisma.eventType.findUnique({
    where: {
      id: input.eventTypeId,
    },
    select: {
      id: true,
      minimumBookingNotice: true,
      length: true,
      seatsPerTimeSlot: true,
      timeZone: true,
      slotInterval: true,
      beforeEventBuffer: true,
      afterEventBuffer: true,
      bookingLimits: true,
      schedulingType: true,
      periodType: true,
      periodStartDate: true,
      periodEndDate: true,
      periodCountCalendarDays: true,
      periodDays: true,
      metadata: true,
      schedule: {
        select: {
          availability: true,
          timeZone: true,
        },
      },
      availability: {
        select: {
          date: true,
          startTime: true,
          endTime: true,
          days: true,
        },
      },
      hosts: {
        select: {
          isFixed: true,
          user: {
            select: availabilityUserSelect,
          },
        },
      },
      users: {
        select: {
          ...availabilityUserSelect,
        },
      },
    },
  });
  if (!eventType) {
    return eventType;
  }

  return {
    ...eventType,
    metadata: EventTypeMetaDataSchema.parse(eventType.metadata),
  };
}

async function getDynamicEventType(ctx: { prisma: typeof prisma }, input: z.infer<typeof getScheduleSchema>) {
  // For dynamic booking, we need to get and update user credentials, schedule and availability in the eventTypeObject as they're required in the new availability logic
  const dynamicEventType = getDefaultEvent(input.eventTypeSlug);
  const users = await ctx.prisma.user.findMany({
    where: {
      username: {
        in: input.usernameList,
      },
    },
    select: {
      allowDynamicBooking: true,
      ...availabilityUserSelect,
    },
  });
  const isDynamicAllowed = !users.some((user) => !user.allowDynamicBooking);
  if (!isDynamicAllowed) {
    throw new TRPCError({
      message: "Some of the users in this group do not allow dynamic booking",
      code: "UNAUTHORIZED",
    });
  }
  return Object.assign({}, dynamicEventType, {
    users,
  });
}

function getRegularOrDynamicEventType(
  ctx: { prisma: typeof prisma },
  input: z.infer<typeof getScheduleSchema>
) {
  const isDynamicBooking = !input.eventTypeId;
  return isDynamicBooking ? getDynamicEventType(ctx, input) : getEventType(ctx, input);
}

const checkIfIsAvailable = ({
  time,
  busy,
  eventLength,
  currentSeats,
}: {
  time: Dayjs;
  busy: EventBusyDate[];
  eventLength: number;
  currentSeats?: CurrentSeats;
}): boolean => {
  if (currentSeats?.some((booking) => booking.startTime.toISOString() === time.toISOString())) {
    return true;
  }

  const slotEndTime = time.add(eventLength, "minutes").utc();
  const slotStartTime = time.utc();

  return busy.every((busyTime) => {
    const startTime = dayjs.utc(busyTime.start).utc();
    const endTime = dayjs.utc(busyTime.end);

    if (endTime.isBefore(slotStartTime) || startTime.isAfter(slotEndTime)) {
      return true;
    }

    if (slotStartTime.isBetween(startTime, endTime, null, "[)")) {
      return false;
    } else if (slotEndTime.isBetween(startTime, endTime, null, "(]")) {
      return false;
    }

    // Check if start times are the same
    if (time.utc().isBetween(startTime, endTime, null, "[)")) {
      return false;
    }
    // Check if slot end time is between start and end time
    else if (slotEndTime.isBetween(startTime, endTime)) {
      return false;
    }
    // Check if startTime is between slot
    else if (startTime.isBetween(time, slotEndTime)) {
      return false;
    }

    return true;
  });
};

/** This should be called getAvailableSlots */
export async function getSchedule(input: z.infer<typeof getScheduleSchema>, ctx: { prisma: typeof prisma }) {
  if (input.debug === true) {
    logger.setSettings({ minLevel: "debug" });
  }
  if (process.env.INTEGRATION_TEST_MODE === "true") {
    logger.setSettings({ minLevel: "silly" });
  }
  const startPrismaEventTypeGet = performance.now();
  const eventType = await getRegularOrDynamicEventType(ctx, input);
  const endPrismaEventTypeGet = performance.now();
  logger.debug(
    `Prisma eventType get took ${endPrismaEventTypeGet - startPrismaEventTypeGet}ms for event:${
      input.eventTypeId
    }`
  );
  if (!eventType) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }

  const startTime =
    input.timeZone === "Etc/GMT"
      ? dayjs.utc(input.startTime)
      : dayjs(input.startTime).utc().tz(input.timeZone);
  const endTime =
    input.timeZone === "Etc/GMT" ? dayjs.utc(input.endTime) : dayjs(input.endTime).utc().tz(input.timeZone);

  if (!startTime.isValid() || !endTime.isValid()) {
    throw new TRPCError({ message: "Invalid time range given.", code: "BAD_REQUEST" });
  }
  let currentSeats: CurrentSeats | undefined = undefined;

  let users = eventType.users.map((user) => ({
    isFixed: !eventType.schedulingType || eventType.schedulingType === SchedulingType.COLLECTIVE,
    ...user,
  }));
  // overwrite if it is a team event & hosts is set, otherwise keep using users.
  if (eventType.schedulingType && !!eventType.hosts?.length) {
    users = eventType.hosts.map(({ isFixed, user }) => ({ isFixed, ...user }));
  }
  /* We get all users working hours and busy slots */
  const userAvailability = await Promise.all(
    users.map(async (currentUser) => {
      const {
        busy,
        workingHours,
        dateOverrides,
        currentSeats: _currentSeats,
        timeZone,
      } = await getUserAvailability(
        {
          userId: currentUser.id,
          username: currentUser.username || "",
          dateFrom: startTime.format(),
          dateTo: endTime.format(),
          eventTypeId: input.eventTypeId,
          afterEventBuffer: eventType.afterEventBuffer,
          beforeEventBuffer: eventType.beforeEventBuffer,
        },
        { user: currentUser, eventType, currentSeats }
      );
      if (!currentSeats && _currentSeats) currentSeats = _currentSeats;

      return {
        timeZone,
        workingHours,
        dateOverrides,
        busy,
        user: currentUser,
      };
    })
  );
  // flattens availability of multiple users
  const dateOverrides = userAvailability.flatMap((availability) =>
    availability.dateOverrides.map((override) => ({ userId: availability.user.id, ...override }))
  );
  const workingHours = getAggregateWorkingHours(userAvailability, eventType.schedulingType);
  const availabilityCheckProps = {
    eventLength: eventType.length,
    currentSeats,
  };

  const isTimeWithinBounds = (_time: Parameters<typeof isTimeOutOfBounds>[0]) =>
    !isTimeOutOfBounds(_time, {
      periodType: eventType.periodType,
      periodStartDate: eventType.periodStartDate,
      periodEndDate: eventType.periodEndDate,
      periodCountCalendarDays: eventType.periodCountCalendarDays,
      periodDays: eventType.periodDays,
    });

  const getSlotsTime = 0;
  let checkForAvailabilityTime = 0;
  const getSlotsCount = 0;
  let checkForAvailabilityCount = 0;

  const timeSlots: ReturnType<typeof getTimeSlots> = [];

  for (
    let currentCheckedTime = startTime;
    currentCheckedTime.isBefore(endTime);
    currentCheckedTime = currentCheckedTime.add(1, "day")
  ) {
    // get slots retrieves the available times for a given day
    timeSlots.push(
      ...getTimeSlots({
        inviteeDate: currentCheckedTime,
        eventLength: input.duration || eventType.length,
        workingHours,
        dateOverrides,
        minimumBookingNotice: eventType.minimumBookingNotice,
        frequency: eventType.slotInterval || input.duration || eventType.length,
      })
    );
  }

  let availableTimeSlots: typeof timeSlots = [];
  availableTimeSlots = timeSlots.filter((slot) => {
    const fixedHosts = userAvailability.filter((availability) => availability.user.isFixed);
    return fixedHosts.every((schedule) => {
      const startCheckForAvailability = performance.now();
      const isAvailable = checkIfIsAvailable({
        time: slot.time,
        ...schedule,
        ...availabilityCheckProps,
      });
      const endCheckForAvailability = performance.now();
      checkForAvailabilityCount++;
      checkForAvailabilityTime += endCheckForAvailability - startCheckForAvailability;
      return isAvailable;
    });
  });
  // what else are you going to call it?
  const looseHostAvailability = userAvailability.filter(({ user: { isFixed } }) => !isFixed);
  if (looseHostAvailability.length > 0) {
    availableTimeSlots = availableTimeSlots
      .map((slot) => {
        slot.userIds = slot.userIds?.filter((slotUserId) => {
          const userSchedule = looseHostAvailability.find(
            ({ user: { id: userId } }) => userId === slotUserId
          );
          if (!userSchedule) {
            return false;
          }
          return checkIfIsAvailable({
            time: slot.time,
            ...userSchedule,
            ...availabilityCheckProps,
          });
        });
        return slot;
      })
      .filter((slot) => !!slot.userIds?.length);
  }

  availableTimeSlots = availableTimeSlots.filter((slot) => isTimeWithinBounds(slot.time));

  const computedAvailableSlots = availableTimeSlots.reduce(
    (
      r: Record<string, { time: string; users: string[]; attendees?: number; bookingUid?: string }[]>,
      { time: time, ...passThroughProps }
    ) => {
      r[time.format("YYYY-MM-DD")] = r[time.format("YYYY-MM-DD")] || [];
      r[time.format("YYYY-MM-DD")].push({
        ...passThroughProps,
        time: time.toISOString(),
        users: (eventType.hosts ? eventType.hosts.map((host) => host.user) : eventType.users).map(
          (user) => user.username || ""
        ),
        // Conditionally add the attendees and booking id to slots object if there is already a booking during that time
        ...(currentSeats?.some((booking) => booking.startTime.toISOString() === time.toISOString()) && {
          attendees:
            currentSeats[
              currentSeats.findIndex((booking) => booking.startTime.toISOString() === time.toISOString())
            ]._count.attendees,
          bookingUid:
            currentSeats[
              currentSeats.findIndex((booking) => booking.startTime.toISOString() === time.toISOString())
            ].uid,
        }),
      });
      return r;
    },
    Object.create(null)
  );

  logger.debug(`getSlots took ${getSlotsTime}ms and executed ${getSlotsCount} times`);

  logger.debug(
    `checkForAvailability took ${checkForAvailabilityTime}ms and executed ${checkForAvailabilityCount} times`
  );
  logger.silly(`Available slots: ${JSON.stringify(computedAvailableSlots)}`);

  return {
    slots: computedAvailableSlots,
  };
}

export default function Type(props: AvailabilityPageProps) {
  const { profile, eventType } = props;
  const userList = eventType.users ? eventType.users.map((user) => user.username).filter(notEmpty) : [];

  const [timeFormat, setTimeFormat] = useState<TimeFormat>(detectBrowserTimeFormat);

  const onTimeFormatChange = (is24Hours: boolean) => {
    setTimeFormat(is24Hours ? TimeFormat.TWENTY_FOUR_HOUR : TimeFormat.TWELVE_HOUR);
  };
  const eventTypeId = eventType.id;
  const eventTypeSlug = eventType.slug;

  const { data, isLoading, isPaused } = trpc.viewer.public.slots.getSchedule.useQuery(
    {
      eventTypeId,
      eventTypeSlug,
      usernameList: userList,
      startTime: "",
      endTime: "",
      timeZone: "UTC",
      duration: "30",
    },
    {
      enabled: false,
    }
  );

  return (
    <SlotPicker
      weekStart={
        typeof profile.weekStart === "string"
          ? (["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(
              profile.weekStart
            ) as 0 | 1 | 2 | 3 | 4 | 5 | 6)
          : profile.weekStart /* Allows providing weekStart as number */
      }
      eventType={eventType}
      timeFormat={TimeFormat.TWENTY_FOUR_HOUR}
      onTimeFormatChange={onTimeFormatChange}
      timeZone="UTC"
      users={userList}
      seatsPerTimeSlot={eventType.seatsPerTimeSlot || undefined}
      recurringEventCount={1}
    />
  );
}

Type.isThemeSupported = true;

async function getUserPageProps(context: GetStaticPropsContext) {
  const { type: slug, user: username } = paramsSchema.parse(context.params);
  const { ssgInit } = await import("@server/lib/ssg");
  const ssg = await ssgInit(context);
  const user = await prisma.user.findUnique({
    where: {
      username,
    },
    select: {
      id: true,
      username: true,
      away: true,
      name: true,
      hideBranding: true,
      timeZone: true,
      theme: true,
      weekStart: true,
      brandColor: true,
      darkBrandColor: true,
      eventTypes: {
        where: {
          // Many-to-many relationship causes inclusion of the team events - cool -
          // but to prevent these from being selected, make sure the teamId is NULL.
          AND: [{ slug }, { teamId: null }],
        },
        select: {
          title: true,
          slug: true,
          hidden: true,
          recurringEvent: true,
          length: true,
          locations: true,
          id: true,
          description: true,
          price: true,
          currency: true,
          requiresConfirmation: true,
          schedulingType: true,
          metadata: true,
          seatsPerTimeSlot: true,
        },
        orderBy: [
          {
            position: "desc",
          },
          {
            id: "asc",
          },
        ],
      },
      teams: {
        include: {
          team: true,
        },
      },
    },
  });

  const md = new MarkdownIt("zero").enable([
    //
    "emphasis",
    "list",
    "newline",
    "strikethrough",
  ]);

  if (!user || !user.eventTypes.length) return { notFound: true };

  const [eventType]: ((typeof user.eventTypes)[number] & {
    users: Pick<User, "name" | "username" | "hideBranding" | "timeZone">[];
  })[] = [
    {
      ...user.eventTypes[0],
      users: [
        {
          name: user.name,
          username: user.username,
          hideBranding: user.hideBranding,
          timeZone: user.timeZone,
        },
      ],
    },
  ];

  if (!eventType) return { notFound: true };

  //TODO: Use zodSchema to verify it instead of using Type Assertion
  const locations = eventType.locations ? (eventType.locations as LocationObject[]) : [];
  const eventTypeObject = Object.assign({}, eventType, {
    metadata: EventTypeMetaDataSchema.parse(eventType.metadata || {}),
    recurringEvent: parseRecurringEvent(eventType.recurringEvent),
    locations: privacyFilteredLocations(locations),
    descriptionAsSafeHTML: eventType.description ? md.render(eventType.description) : null,
  });
  // Check if the user you are logging into has any active teams
  const hasActiveTeam =
    user.teams.filter((m) => {
      if (!IS_TEAM_BILLING_ENABLED) return true;
      const metadata = teamMetadataSchema.safeParse(m.team.metadata);
      if (metadata.success && metadata.data?.subscriptionId) return true;
      return false;
    }).length > 0;

  return {
    props: {
      eventType: eventTypeObject,
      profile: {
        ...eventType.users[0],
        theme: user.theme,
        allowDynamicBooking: false,
        weekStart: user.weekStart,
        brandColor: user.brandColor,
        darkBrandColor: user.darkBrandColor,
        slug: `${user.username}/${eventType.slug}`,
        image: `${WEBAPP_URL}/${user.username}/avatar.png`,
      },
      away: user?.away,
      isDynamic: false,
      trpcState: ssg.dehydrate(),
      isBrandingHidden: isBrandingHidden(user.hideBranding, hasActiveTeam),
    },
    revalidate: 10, // seconds
  };
}

async function getDynamicGroupPageProps(context: GetStaticPropsContext) {
  const { ssgInit } = await import("@server/lib/ssg");
  const ssg = await ssgInit(context);
  const { type: typeParam, user: userParam } = paramsSchema.parse(context.params);
  const usernameList = getUsernameList(userParam);
  const length = parseInt(typeParam);
  const eventType = getDefaultEvent("" + length);

  const users = await prisma.user.findMany({
    where: {
      username: {
        in: usernameList,
      },
    },
    select: {
      id: true,
      username: true,
      name: true,
      email: true,
      bio: true,
      avatar: true,
      startTime: true,
      endTime: true,
      timeZone: true,
      weekStart: true,
      availability: true,
      hideBranding: true,
      brandColor: true,
      darkBrandColor: true,
      defaultScheduleId: true,
      allowDynamicBooking: true,
      away: true,
      schedules: {
        select: {
          availability: true,
          timeZone: true,
          id: true,
        },
      },
      theme: true,
    },
  });

  if (!users.length) {
    return {
      notFound: true,
    };
  }

  const locations = eventType.locations ? (eventType.locations as LocationObject[]) : [];
  const eventTypeObject = Object.assign({}, eventType, {
    metadata: EventTypeMetaDataSchema.parse(eventType.metadata || {}),
    recurringEvent: parseRecurringEvent(eventType.recurringEvent),
    locations: privacyFilteredLocations(locations),
    users: users.map((user) => {
      return {
        name: user.name,
        username: user.username,
        hideBranding: user.hideBranding,
        timeZone: user.timeZone,
      };
    }),
  });

  const dynamicNames = users.map((user) => {
    return user.name || "";
  });

  const profile = {
    name: getGroupName(dynamicNames),
    image: null,
    slug: "" + length,
    theme: null as string | null,
    weekStart: "Sunday",
    brandColor: "",
    darkBrandColor: "",
    allowDynamicBooking: !users.some((user) => {
      return !user.allowDynamicBooking;
    }),
  };

  return {
    props: {
      eventType: eventTypeObject,
      profile,
      isDynamic: true,
      away: false,
      trpcState: ssg.dehydrate(),
      isBrandingHidden: false, // I think we should always show branding for dynamic groups - saves us checking every single user
    },
    revalidate: 10, // seconds
  };
}

const paramsSchema = z.object({ type: z.string(), user: z.string() });

export const getStaticProps = async (context: GetStaticPropsContext) => {
  const { user: userParam } = paramsSchema.parse(context.params);
  // dynamic groups are not generated at build time, but otherwise are probably cached until infinity.
  const isDynamicGroup = userParam.includes("+");
  if (isDynamicGroup) {
    return await getDynamicGroupPageProps(context);
  } else {
    return await getUserPageProps(context);
  }
};

export const getStaticPaths: GetStaticPaths = async () => {
  return { paths: [], fallback: "blocking" };
};
