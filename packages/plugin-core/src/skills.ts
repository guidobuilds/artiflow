import { readFile } from "node:fs/promises";

const BASE_SKILLS = ["creating-artifacts", "using-artiflow"] as const;

export type BaseSkill = { name: string; text: string };

export async function loadBaseSkills(): Promise<BaseSkill[]> {
  return Promise.all(
    BASE_SKILLS.map(async (name) => ({
      name,
      text: await readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8"),
    })),
  );
}
