/** Public account fields for roster/detail payloads. Never select credentials. */
export const USER_PROFILE_SELECT = {
  id: true,
  email: true,
  username: true,
  firstName: true,
  lastName: true,
  role: true,
  createdAt: true,
} as const;
