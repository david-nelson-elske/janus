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
import { AdrDetail } from './components/adr-detail';
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
    component: AdrDetail as any,
    view: 'detail',
    config: {
      fields: {
        title: { component: 'heading', agent: 'read-write', label: 'Title' },
        summary: { component: 'richtext', agent: 'read-write' },
        content: { component: 'richtext', agent: 'read-write' },
        status: { component: 'badge', agent: 'read' },
      },
      layout: 'single-column',
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
