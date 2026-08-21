import "server-only";

import type { Prisma } from "@terrablox/database";

import {
  moduleRegistryUrl,
  providerDocsUrl,
  resourceDocsUrl,
} from "./registry";
import type { TerraformAnalysis } from "./types";

/**
 * Writes an analysis to the tables that hang off a module.
 *
 * Everything is replaced rather than diffed: an analysis is a pure function of
 * the module's source at a given ref, so a re-import must be able to correct
 * previously wrong rows instead of accumulating them.
 */
export async function persistAnalysis(
  tx: Prisma.TransactionClient,
  moduleId: string,
  analysis: TerraformAnalysis,
): Promise<void> {
  const providersByName = new Map(analysis.providers.map((p) => [p.name, p]));

  await Promise.all([
    tx.providerResource.deleteMany({ where: { moduleId } }),
    tx.moduleDependency.deleteMany({ where: { moduleId } }),
    tx.moduleProvider.deleteMany({ where: { moduleId } }),
    tx.resourceReference.deleteMany({ where: { moduleId } }),
  ]);

  const providerRows: Prisma.ModuleProviderCreateManyInput[] =
    analysis.providers.map((p) => ({
      moduleId,
      name: p.name,
      source: p.source,
      version: p.version,
      docsUrl: providerDocsUrl(p),
    }));

  const resourceRows: Prisma.ProviderResourceCreateManyInput[] =
    analysis.resources.map((r) => {
      const provider = providersByName.get(r.provider);

      return {
        moduleId,
        kind: r.kind,
        resourceType: r.type,
        resourceName: r.name,
        providerName: r.provider,
        version: provider?.version ?? null,
        sourceFile: r.file,
        conditionalOn: r.conditionalOn,
        resourceUrl: resourceDocsUrl({
          resourceType: r.type,
          kind: r.kind,
          provider,
          providerLocalName: r.provider,
        }),
        providerUrl: provider ? providerDocsUrl(provider) : null,
        resourceDescription: null,
      };
    });

  const dependencyRows: Prisma.ModuleDependencyCreateManyInput[] =
    analysis.moduleCalls.map((m) => ({
      moduleId,
      name: m.name,
      source: m.source,
      version: m.version,
      sourceKind: m.sourceKind,
      registryUrl:
        m.sourceKind === "registry" ? moduleRegistryUrl(m.source) : null,
      sourceFile: m.file,
    }));

  const referenceRows: Prisma.ResourceReferenceCreateManyInput[] =
    analysis.references.map((r) => ({
      moduleId,
      fromAddress: r.fromAddress,
      fromKind: r.fromKind,
      toAddress: r.toAddress,
      toKind: r.toKind,
      attributes: r.attributes,
      viaLocals: r.viaLocals,
    }));

  if (providerRows.length) {
    await tx.moduleProvider.createMany({ data: providerRows });
  }
  if (resourceRows.length) {
    await tx.providerResource.createMany({ data: resourceRows });
  }
  if (dependencyRows.length) {
    await tx.moduleDependency.createMany({ data: dependencyRows });
  }
  if (referenceRows.length) {
    await tx.resourceReference.createMany({ data: referenceRows });
  }
}
