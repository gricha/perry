import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { AgentType, Skill } from '@shared/client-types';
import { AGENT_TYPES } from '@shared/client-types';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';

const AGENT_LABELS: Record<AgentType, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  pi: 'Pi',
};

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toSkillMd(skill: Pick<Skill, 'name' | 'description'> & { body: string }): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body.trim()}\n`;
}

function defaultSkillMd(slug: string): string {
  return toSkillMd({
    name: slug,
    description: 'Describe what this skill does and when to use it.',
    body: '# Instructions\n\n- Provide step-by-step guidance.\n',
  });
}

function newSkill(): Skill {
  const id = `skill_${Math.random().toString(16).slice(2)}`;
  const name = 'new-skill';
  return {
    id,
    name,
    description: 'Describe what this skill does and when to use it.',
    enabled: true,
    appliesTo: 'all',
    skillMd: defaultSkillMd(name),
  };
}

function normalizeSkill(skill: Skill): Skill {
  const safeName = slugify(skill.name) || 'skill';
  const safeDescription =
    skill.description?.trim() || 'Describe what this skill does and when to use it.';
  return {
    ...skill,
    name: safeName,
    description: safeDescription,
    skillMd: skill.skillMd?.trim().length ? skill.skillMd : defaultSkillMd(safeName),
  };
}

export function Skills() {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['skills'],
    queryFn: api.getSkills,
  });

  const [drafts, setDrafts] = useState<Skill[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (data && !initialized) {
      setDrafts(data.map(normalizeSkill));
      setInitialized(true);
    }
  }, [data, initialized]);

  const mutation = useMutation({
    mutationFn: (skills: Skill[]) => api.updateSkills(skills.map(normalizeSkill)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      setHasChanges(false);
    },
  });

  const setSkill = (index: number, next: Skill) => {
    const updated = [...drafts];
    updated[index] = next;
    setDrafts(updated);
    setHasChanges(true);
  };

  const removeSkill = (index: number) => {
    setDrafts(drafts.filter((_, i) => i !== index));
    setHasChanges(true);
  };

  const addSkill = () => {
    setDrafts([...drafts, newSkill()]);
    setHasChanges(true);
  };

  const toggleAgent = (index: number, agent: AgentType) => {
    const skill = drafts[index];

    if (skill.appliesTo === 'all') {
      const next = AGENT_TYPES.filter((a) => a !== agent);
      setSkill(index, { ...skill, appliesTo: next });
      return;
    }

    const set = new Set(skill.appliesTo);
    if (set.has(agent)) set.delete(agent);
    else set.add(agent);

    const next = Array.from(set);
    setSkill(index, { ...skill, appliesTo: next.length === AGENT_TYPES.length ? 'all' : next });
  };

  const setAllAgents = (index: number, enabled: boolean) => {
    const skill = drafts[index];
    setSkill(index, { ...skill, appliesTo: enabled ? 'all' : [] });
  };

  const handleSave = () => {
    mutation.mutate(drafts);
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <div className="text-destructive mb-4 text-center">
          <p className="font-medium">Failed to load skills</p>
          <p className="text-sm text-muted-foreground mt-1">Please check your connection</p>
        </div>
        <Button onClick={() => refetch()} variant="outline" size="sm">
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-8 max-w-2xl mx-auto">
        <div className="page-header">
          <h1 className="page-title">Skills</h1>
          <p className="page-description">SKILL.md definitions synced into workspaces</p>
        </div>
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-10 bg-secondary rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-2xl mx-auto">
      <div className="page-header">
        <h1 className="page-title">Skills</h1>
        <p className="page-description">SKILL.md definitions synced into workspaces</p>
      </div>

      <div className="flex items-center justify-between">
        <Button onClick={addSkill} variant="outline" size="sm">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add Skill
        </Button>

        <Button onClick={handleSave} disabled={mutation.isPending || !hasChanges} size="sm">
          <Save className="mr-1.5 h-3.5 w-3.5" />
          Save
        </Button>
      </div>

      {drafts.length === 0 ? (
        <div className="border border-dashed border-muted-foreground/20 rounded-lg p-8 text-center">
          <p className="text-sm text-muted-foreground">No skills configured</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Click “Add Skill” to create one</p>
        </div>
      ) : (
        <div className="space-y-4">
          {drafts.map((skill, index) => {
            const parsedFrontmatterWarning = (() => {
              const slug = slugify(skill.name);
              if (!slug) return 'Skill name is invalid; it will be normalized on save.';
              if (slug !== skill.name) return 'Skill name should be a slug (lowercase + hyphens).';
              if (!skill.skillMd.trim().startsWith('---'))
                return 'SKILL.md should start with YAML frontmatter.';
              return null;
            })();

            return (
              <div key={skill.id} className="border rounded-lg p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={skill.name}
                        onChange={(e) => setSkill(index, { ...skill, name: e.target.value })}
                        className="font-mono"
                        placeholder="skill-name"
                      />
                      <Button variant="ghost" size="icon" onClick={() => removeSkill(index)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    <div className="flex items-center gap-2">
                      <Switch
                        checked={skill.enabled}
                        onCheckedChange={(checked) =>
                          setSkill(index, { ...skill, enabled: checked })
                        }
                      />
                      <span className="text-sm text-muted-foreground">Enabled</span>
                      <span className="text-xs text-muted-foreground/60 font-mono">{skill.id}</span>
                    </div>

                    <Input
                      value={skill.description}
                      placeholder="Description (used for discovery/triggering)"
                      onChange={(e) => setSkill(index, { ...skill, description: e.target.value })}
                    />

                    <div className="space-y-2">
                      <div className="text-sm font-medium">Applies To</div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={skill.appliesTo === 'all'}
                          onCheckedChange={(checked) => setAllAgents(index, checked)}
                        />
                        <span className="text-sm">All agent types</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {AGENT_TYPES.map((agent) => {
                          const active = (
                            skill.appliesTo === 'all' ? AGENT_TYPES : skill.appliesTo
                          ).includes(agent);
                          return (
                            <Button
                              key={agent}
                              type="button"
                              variant={active ? 'default' : 'outline'}
                              size="sm"
                              onClick={() => toggleAgent(index, agent)}
                            >
                              {AGENT_LABELS[agent]}
                            </Button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium">SKILL.md</div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const slug = slugify(skill.name) || 'skill';
                            setSkill(index, {
                              ...skill,
                              name: slug,
                              skillMd: toSkillMd({
                                name: slug,
                                description: skill.description,
                                body:
                                  skill.skillMd.split('---').slice(2).join('---').trim() ||
                                  '# Instructions\n',
                              }),
                            });
                          }}
                        >
                          Regenerate frontmatter
                        </Button>
                      </div>

                      {parsedFrontmatterWarning ? (
                        <div className="text-xs text-amber-500">{parsedFrontmatterWarning}</div>
                      ) : null}

                      <Textarea
                        value={skill.skillMd}
                        onChange={(e) => setSkill(index, { ...skill, skillMd: e.target.value })}
                        className="font-mono"
                        rows={12}
                      />

                      <div className="text-xs text-muted-foreground">
                        Synced into workspaces at{' '}
                        <code className="font-mono">.claude/skills/&lt;name&gt;/SKILL.md</code>.
                        OpenCode will also discover these via its Claude-compatible search paths.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {mutation.error && (
        <div className="mt-4 rounded border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{(mutation.error as Error).message}</p>
        </div>
      )}
    </div>
  );
}

export default Skills;
