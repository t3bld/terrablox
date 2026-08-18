"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Avatar, AvatarFallback, AvatarImage } from "@terrablox/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@terrablox/ui/sidebar";
import {
  Bot,
  Boxes,
  Building2,
  ChevronUp,
  FolderKanban,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  User2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const navItems = [
  {
    title: "Projects",
    href: "/projects",
    icon: FolderKanban,
  },
  {
    title: "Modules",
    href: "/modules",
    icon: Boxes,
  },
];

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { state, isMobile, toggleSidebar } = useSidebar();

  // On mobile the sidebar is an overlay that is either fully there or gone, so
  // the icon rail never applies and closing it is the sheet's own job.
  const iconOnly = state === "collapsed" && !isMobile;

  const handleSignOut = async () => {
    await signOut({
      onSuccess: () => {
        router.push("/login");
      },
    });
  };

  return (
    // Collapsing to icons rather than off-canvas keeps navigation one click away
    // while the canvas gets the width.
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-1">
            {iconOnly ? (
              // Only one control fits across 3rem, so the logo becomes the way
              // back out — the same spot that collapsed it.
              <SidebarMenuButton
                size="lg"
                onClick={toggleSidebar}
                tooltip="Expand sidebar (Ctrl/⌘ B)"
                aria-label="Expand sidebar"
                className="group/brand"
              >
                <div className="relative flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <span className="font-bold text-lg transition-opacity group-hover/brand:opacity-0">
                    T
                  </span>
                  <PanelLeftOpen className="absolute size-4 opacity-0 transition-opacity group-hover/brand:opacity-100" />
                </div>
              </SidebarMenuButton>
            ) : (
              <>
                <SidebarMenuButton size="lg" asChild className="flex-1">
                  <Link href="/">
                    <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                      <span className="font-bold text-lg">T</span>
                    </div>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-semibold">TerraBlox</span>
                    </div>
                  </Link>
                </SidebarMenuButton>

                {isMobile ? null : (
                  <button
                    type="button"
                    onClick={toggleSidebar}
                    aria-label="Collapse sidebar"
                    title="Collapse sidebar (Ctrl/⌘ B)"
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  >
                    <PanelLeftClose className="size-4" />
                  </button>
                )}
              </>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== "/" && pathname.startsWith(`${item.href}/`));

                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.title}
                    >
                      <Link href={item.href}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <Avatar className="h-8 w-8 rounded-lg">
                    <AvatarImage src={undefined} alt={user?.name || "User"} />
                    <AvatarFallback className="rounded-lg bg-primary text-primary-foreground">
                      {user?.name?.[0]?.toUpperCase() ||
                        user?.email?.[0]?.toUpperCase() ||
                        "U"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">
                      {user?.name || "User"}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {user?.email}
                    </span>
                  </div>
                  <ChevronUp className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
                side="top"
                align="end"
                sideOffset={4}
              >
                <DropdownMenuItem asChild>
                  <Link href="/account" className="cursor-pointer">
                    <User2 className="mr-2 h-4 w-4" />
                    Account
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/agent" className="cursor-pointer">
                    <Bot className="mr-2 h-4 w-4" />
                    Agent
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/company" className="cursor-pointer">
                    <Building2 className="mr-2 h-4 w-4" />
                    Company
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleSignOut}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      {/* Drag/click strip on the border, for people who never find the button. */}
      <SidebarRail />
    </Sidebar>
  );
}
