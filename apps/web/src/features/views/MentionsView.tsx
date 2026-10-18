import type {Layout} from '../shell/layout';
import {ActivityInbox} from './ActivityInbox';
export function MentionsView(props:{orgId:string;layout:Layout;embedded?:boolean}) {return <ActivityInbox {...props} kind="mention"/>;}
