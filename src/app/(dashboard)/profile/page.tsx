"use client";
import { UserRound } from "lucide-react";
import { ProfileDetails } from "./profile-details";
import { ChangePassword } from "./change-password";

export default function ProfilePage() {
  return (
    <div className="p-4 md:p-6 space-y-8">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <UserRound className="size-6" /> My Profile
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Your account details and password. Changes here apply everywhere you sign in.
        </p>
      </div>

      <ProfileDetails />
      <ChangePassword />
    </div>
  );
}
