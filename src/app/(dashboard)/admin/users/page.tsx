"use client";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAlert } from "@/components/ui/confirm-dialog";
import { Search, Trash2, Shield, Users, GraduationCap } from "lucide-react";
import { cn } from "@/lib/utils";

interface User {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  role: string;
  createdAt: string;
}

const getRoleIcon = (role: string) => {
  switch (role) {
    case "ADMIN": return <Shield className="size-4 text-purple-500" />;
    case "TEACHER": return <Users className="size-4 text-blue-500" />;
    default: return <GraduationCap className="size-4 text-green-500" />;
  }
};

export default function AdminUsersPage() {
  const { data: session } = useSession();
  const alert = useAlert();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [deleteUser, setDeleteUser] = useState<User | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, []);

  async function fetchUsers() {
    try {
      const res = await fetch("/api/admin/users");
      if (res.ok) {
        const data = await res.json();
        setUsers(data);
      }
    } catch (err) {
      console.error("Failed to fetch users", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!deleteUser) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/admin/users/${deleteUser.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setUsers(users.filter(u => u.id !== deleteUser.id));
        setDeleteUser(null);
      } else {
        const data = await res.json();
        await alert({ title: "Couldn't delete user", description: data.error || "Failed to delete user" });
      }
    } catch (err) {
      console.error("Error deleting user", err);
      await alert({ title: "Couldn't delete user", description: "Error deleting user" });
    } finally {
      setIsDeleting(false);
    }
  }

  const filteredUsers = users.filter((u) => {
    const term = search.toLowerCase();
    return (
      u.username.toLowerCase().includes(term) ||
      u.email.toLowerCase().includes(term) ||
      u.firstName.toLowerCase().includes(term) ||
      u.lastName.toLowerCase().includes(term)
    );
  });

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Users</h1>
          <p className="text-muted-foreground mt-1">
            Manage all students, teachers, and admins.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search users..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="border border-border rounded-lg bg-card overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border">
            <tr>
              <th className="px-6 py-4 font-medium">User</th>
              <th className="px-6 py-4 font-medium">Role</th>
              <th className="px-6 py-4 font-medium">Joined</th>
              <th className="px-6 py-4 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? (
              <tr>
                <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">
                  Loading users…
                </td>
              </tr>
            ) : filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">
                  No users found.
                </td>
              </tr>
            ) : (
              filteredUsers.map((user) => (
                <tr key={user.id} className="hover:bg-muted/50 transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex flex-col">
                      <span className="font-medium text-foreground">{user.firstName} {user.lastName}</span>
                      <span className="text-xs text-muted-foreground">{user.email} &bull; @{user.username}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      {getRoleIcon(user.role)}
                      <span className="capitalize">{user.role.toLowerCase()}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-muted-foreground">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteUser(user)}
                      disabled={user.id === session?.user?.id}
                      className={cn(
                        "text-destructive hover:text-destructive hover:bg-destructive/10 size-8",
                        user.id === session?.user?.id && "opacity-50 cursor-not-allowed"
                      )}
                      title={user.id === session?.user?.id ? "Cannot delete yourself" : "Delete user"}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!deleteUser} onOpenChange={(o) => !o && setDeleteUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-bold text-foreground">
                {deleteUser?.firstName} {deleteUser?.lastName}
              </span>
              ?
              <br /><br />
              <strong className="text-destructive">Warning:</strong> This action cannot be undone. 
              {deleteUser?.role === "TEACHER" && " All classes and materials created by this teacher will also be permanently deleted."}
              {deleteUser?.role === "STUDENT" && " All class enrollments and progress will be permanently deleted."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteUser(null)} disabled={isDeleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? "Deleting..." : "Delete User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
