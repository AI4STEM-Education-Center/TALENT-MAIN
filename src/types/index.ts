// Application-level type constants

export const Role = {
  TEACHER: "TEACHER",
  STUDENT: "STUDENT",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const DifficultyLevel = {
  BEGINNER: "BEGINNER",
  INTERMEDIATE: "INTERMEDIATE",
  ADVANCED: "ADVANCED",
} as const;
export type DifficultyLevel = (typeof DifficultyLevel)[keyof typeof DifficultyLevel];

export const ProgressStatus = {
  NOT_STARTED: "NOT_STARTED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
} as const;
export type ProgressStatus = (typeof ProgressStatus)[keyof typeof ProgressStatus];

// Extended types with relations
export type UserWithRole = {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  role: Role;
};
