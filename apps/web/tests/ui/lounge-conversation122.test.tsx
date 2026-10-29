import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { channel, server, ORG, CHAN, USER } from './collaboration-fixture';
import { initialState } from '../../src/store/state';
import { actions, setState } from '../../src/store';
vi.mock('../../src/features/calls/Room', () => ({ AudioRoomPanel: ({channelId}:{channelId:string}) => <section aria-label="Real room slot">{channelId}</section> }));
vi.mock('../../src/features/conversation/ConversationHeader', () => ({ ConversationHeader: () => <header>Conversation</header> }));
vi.mock('../../src/features/conversation/MessageList', () => ({ MessageList: () => <div>Chat messages</div> }));
vi.mock('../../src/features/conversation/Composer', () => ({ Composer: ({autoFocus}:{autoFocus:boolean}) => <div data-testid="composer" data-autofocus={String(autoFocus)} /> }));
vi.mock('../../src/features/conversation/TypingLine', () => ({ TypingLine: () => null }));
vi.mock('../../src/features/shell/layout', () => ({ useLayout: () => 'desktop', usePane: () => null, closePane: vi.fn() }));
import { Conversation } from '../../src/features/conversation/Conversation';
beforeEach(() => {
  localStorage.clear(); setState(initialState());
  vi.spyOn(actions,'openChannel').mockResolvedValue(undefined);vi.spyOn(actions,'closeChannel').mockResolvedValue(undefined);
  setState({session:{status:'signed_in',userId:USER,email:null,setup:null},orgId:ORG,bootstrap:{status:'ready',error:null},servers:{[server.id]:server},channels:{[CHAN]:channel},timelines:{[CHAN]:{ids:[],status:'ready',hasMore:false,error:null}}} as never);
});
afterEach(() => { cleanup();vi.restoreAllMocks(); });
const view=()=>render(<Conversation orgId={ORG} channelId={CHAN} messageId={null} threadId={null} threadMessageId={null}/>);
it('audio conversations mount the room panel alongside chat and do not summon the keyboard', () => {
  setState({channels:{[CHAN]:{...channel,kind:'audio'}}});view();
  expect(screen.getByRole('region',{name:'Real room slot'}).textContent).toBe(CHAN);
  expect(screen.getByText('Voice lounge').closest('details')?.open).toBe(true);
  expect(screen.getByText('Chat messages')).toBeTruthy();
  expect(screen.getByTestId('composer').getAttribute('data-autofocus')).toBe('false');
});
it('ordinary text conversations retain chat autofocus and have no room panel', () => {
  view();expect(screen.queryByRole('region',{name:'Real room slot'})).toBeNull();
  expect(screen.getByTestId('composer').getAttribute('data-autofocus')).toBe('true');
});
