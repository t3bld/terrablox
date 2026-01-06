"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@terrablox/auth";
import type { Project } from "@terrablox/database";

import { UserMenu } from "@/components/user-menu";
import { getProjects } from "@/actions/project-actions";

export default function DashboardPage() {
  const router = useRouter();
  const { user, isLoading, isAuthenticated } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/login");
    }
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    async function fetchProjects() {
      if (user?.id) {
        try {
          const data = await getProjects(user.id);
          setProjects(data);
        } catch {
          setProjects([]);
        } finally {
          setProjectsLoading(false);
        }
      }
    }

    if (isAuthenticated && user?.id) {
      fetchProjects();
    }
  }, [isAuthenticated, user?.id]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <h1 className="text-xl font-bold text-gray-900">TerraBLox</h1>
            <UserMenu />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900">
            Welcome back{user?.name ? `, ${user.name}` : ""}!
          </h2>
          <p className="text-gray-600 mt-1">
            Here&apos;s what&apos;s happening with your projects.
          </p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
            <h3 className="text-lg font-semibold text-gray-900">Projects</h3>
            <button className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
              New Project
            </button>
          </div>
          <div className="p-6">
            {projectsLoading ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
              </div>
            ) : projects.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>No projects yet.</p>
                <p className="text-sm mt-1">
                  Create your first project to get started.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {projects.map((project) => (
                  <div
                    key={project.id}
                    className="border border-gray-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer"
                  >
                    <h4 className="text-sm font-medium text-gray-900">
                      {project.name}
                    </h4>
                    <p className="text-xs text-gray-500 mt-1">
                      {project.description || "No description"}
                    </p>
                    <p className="text-xs text-gray-400 mt-2">
                      Updated {new Date(project.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
