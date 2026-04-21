/**
 * Demo bindings — real Preact components wired via bind().
 *
 * M8-render: replaces the M8-core placeholder component functions
 * with actual Preact components for SSR rendering.
 */

import { bind } from '@janus/core';
import { task, adr, question } from './entities';
import { TaskDetail } from './components/task-detail';
import { TaskList } from './components/task-list';
import { AdrDetailComposed } from './components/adr-detail-composed';
import { AdrList } from './components/adr-list';
import { QuestionDetail } from './components/question-detail';
import { QuestionList } from './components/question-list';

export const taskBinding = bind(task, [
  {
    component: TaskDetail as any,
    view: 'detail',
    config: {
      fields: {
        title: { component: 'heading', agent: 'read-write', label: 'Title' },
        description: { component: 'richtext', agent: 'read-write' },
        status: { component: 'badge', agent: 'read' },
        priority: { component: 'badge', agent: 'read' },
      },
      layout: 'single-column',
    },
  },
  {
    component: TaskList as any,
    view: 'list',
    config: {
      columns: ['title', 'status', 'priority', 'assignee'],
      fields: {
        title: { agent: 'read' },
        status: { agent: 'read' },
        priority: { agent: 'read' },
        assignee: { agent: 'read' },
      },
    },
  },
]);

export const adrBinding = bind(adr, [
  {
    // ADR-124-12d: the detail page is built by a loader that composes
    // the adr record with its linked questions. The component receives
    // the composed payload on `data`; `fields`/`layout` are no longer
    // driving the render (the component owns the layout).
    component: AdrDetailComposed as any,
    view: 'detail',
    config: {
      loader: async (ctx) => {
        const adr = await ctx.read('adr', { id: ctx.params.id });
        const qPage = (await ctx.read('question', {
          where: { adr: ctx.params.id },
        })) as { records: readonly Record<string, unknown>[] };
        return { adr, questions: qPage.records };
      },
    },
  },
  {
    component: AdrList as any,
    view: 'list',
    config: {
      columns: ['number', 'title', 'status'],
      fields: {
        number: { agent: 'read' },
        title: { agent: 'read' },
        status: { agent: 'read' },
      },
    },
  },
]);

export const questionBinding = bind(question, [
  {
    component: QuestionDetail as any,
    view: 'detail',
    config: {
      fields: {
        title: { component: 'heading', agent: 'read-write', label: 'Title' },
        context: { component: 'richtext', agent: 'read-write' },
        resolution: { component: 'richtext', agent: 'read-write' },
        status: { component: 'badge', agent: 'read' },
      },
      layout: 'single-column',
    },
  },
  {
    component: QuestionList as any,
    view: 'list',
    config: {
      columns: ['title', 'status'],
      fields: {
        title: { agent: 'read' },
        status: { agent: 'read' },
      },
    },
  },
]);

export const allBindings = [taskBinding, adrBinding, questionBinding];
