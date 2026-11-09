import { z } from "zod";

/**
 * Response shapes of the Moodle 5.2 core functions this connector uses.
 * Lenient on purpose: unknown fields are ignored, optional fields tolerate absence
 * (Moodle omits fields the caller may not see). Only what the port needs is read.
 */

const num = z.coerce.number();
const optNum = z.coerce.number().nullish();

export const siteInfoSchema = z.object({
  functions: z.array(z.object({ name: z.string() })).nullish(),
});

export const categoriesSchema = z.array(
  z.object({
    id: num,
    name: z.string(),
    parent: num,
    path: z.string(),
  }),
);

export const coursesByFieldSchema = z.object({
  courses: z.array(
    z.object({
      id: num,
      fullname: z.string(),
      shortname: z.string(),
      categoryid: num,
      visible: optNum,
      enablecompletion: optNum,
      startdate: optNum,
      enddate: optNum,
    }),
  ),
});

const customFields = z.array(z.object({ shortname: z.string(), value: z.unknown().nullish() })).nullish();

export const enrolledUsersSchema = z.array(
  z.object({
    id: num,
    username: z.string().nullish(),
    firstname: z.string().nullish(),
    lastname: z.string().nullish(),
    roles: z.array(z.object({ shortname: z.string() })).nullish(),
    customfields: customFields,
    lastaccess: optNum,
    lastcourseaccess: optNum,
  }),
);

export const usersByFieldSchema = z.array(
  z.object({
    id: num,
    username: z.string().nullish(),
    firstname: z.string().nullish(),
    lastname: z.string().nullish(),
    /** Read only to derive the domain; the address itself is dropped in the adapter. */
    email: z.string().nullish(),
    suspended: z.union([z.boolean(), num]).nullish(),
    lastaccess: optNum,
    customfields: customFields,
  }),
);

export const usersCoursesSchema = z.array(
  z.object({
    id: num,
    fullname: z.string(),
    enablecompletion: z.union([z.boolean(), num]).nullish(),
    lastaccess: optNum,
    progress: optNum,
    completed: z.boolean().nullish(),
  }),
);

export const gradeItemsSchema = z.object({
  usergrades: z.array(
    z.object({
      userid: num,
      gradeitems: z.array(
        z.object({
          itemtype: z.string().nullish(),
          itemmodule: z.string().nullish(),
          graderaw: optNum,
          grademax: optNum,
        }),
      ),
    }),
  ),
});

export type RawCustomFields = z.infer<typeof customFields>;
