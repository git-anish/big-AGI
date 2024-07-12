import { getImageAsset } from '~/modules/dblobs/dblobs.images';

import type { DMessage } from '~/common/stores/chat/chat.message';
import { DMessageImageRefPart, isContentFragment, isContentOrAttachmentFragment, isTextPart } from '~/common/stores/chat/chat.fragments';
import { LLMImageResizeMode, resizeBase64ImageIfNeeded } from '~/common/util/imageUtils';

import { AixChatContentGenerateRequest, AixChatMessageModel, AixChatMessageUser, createAixInlineImagePart, createAixMetaReplyToPart } from './aix.client.api';


// TODO: remove console messages to zero, or replace with throws or something


// configuration
export const MODEL_IMAGE_RESCALE_MIMETYPE = 'image/webp';
export const MODEL_IMAGE_RESCALE_QUALITY = 0.90;


//
// AIX <> Chat Messages API helpers
//

export async function conversationMessagesToAixGenerateRequest(messageSequence: Readonly<DMessage[]>): Promise<AixChatContentGenerateRequest> {
  // reduce history
  return await messageSequence.reduce(async (accPromise, m, index) => {
    const acc = await accPromise;

    // extract system
    if (index === 0 && m.role === 'system') {
      // create parts if not exist
      if (!acc.systemMessage) {
        acc.systemMessage = {
          parts: [],
        };
      }
      for (const systemFragment of m.fragments) {
        if (isContentFragment(systemFragment) && isTextPart(systemFragment.part)) {
          acc.systemMessage.parts.push(systemFragment.part);
        } else {
          console.warn('conversationMessagesToAixGenerateRequest: unexpected system fragment', systemFragment);
        }
      }
      return acc;
    }

    // map the other parts
    if (m.role === 'user') {

      const dMEssageUserFragments = m.fragments;
      const aixChatMessageUser = await dMEssageUserFragments.reduce(async (mMsgPromise, uFragment) => {

        const uMsg = await mMsgPromise;
        if (!isContentOrAttachmentFragment(uFragment) || uFragment.part.pt === '_pt_sentinel' || uFragment.part.pt === 'ph')
          return uMsg;

        switch (uFragment.part.pt) {
          case 'text':
            uMsg.parts.push(uFragment.part);
            break;

          case 'image_ref':
            // note, we don't resize, as the user image is resized following the user's preferences
            uMsg.parts.push(await _convertImageRefToInlineImageOrThrow(uFragment.part, false));
            break;

          case 'doc':
            uMsg.parts.push(uFragment.part);
            break;

          // skipped (non-user)
          case 'error':
          case 'tool_call':
          case 'tool_response':
            break;

          default:
            console.warn('conversationMessagesToAixGenerateRequest: unexpected User fragment part type', (uFragment.part as any).pt);
        }
        return uMsg;
      }, Promise.resolve({ role: 'user', parts: [] } as AixChatMessageUser));

      // handle metadata on user messages
      if (m.metadata?.inReplyToText)
        aixChatMessageUser.parts.push(createAixMetaReplyToPart(m.metadata.inReplyToText));

      acc.chatSequence.push(aixChatMessageUser);

    } else if (m.role === 'assistant') {

      const dMessageAssistantFragments = m.fragments;
      const aixChatMessageModel = await dMessageAssistantFragments.reduce(async (mMsgPromise, aFragment) => {

        const mMsg = await mMsgPromise;
        if (!isContentOrAttachmentFragment(aFragment) || aFragment.part.pt === '_pt_sentinel' || aFragment.part.pt === 'ph')
          return mMsg;

        switch (aFragment.part.pt) {

          // intake.message.part = fragment.part
          case 'text':
          case 'tool_call':
            mMsg.parts.push(aFragment.part);
            break;

          case 'doc':
            // TODO
            console.warn('conversationMessagesToAixGenerateRequest: doc part not implemented yet');
            // mMsg.parts.push(aFragment.part);
            break;

          case 'error':
            mMsg.parts.push({ pt: 'text', text: `[ERROR] ${aFragment.part.error}` });
            break;

          case 'image_ref':
            // TODO: rescale shall be dependent on the LLM here - and be careful with the high-res options, as they can
            //  be really space consuming. how to choose between high and low? global option?
            const resizeMode: LLMImageResizeMode = 'openai-low-res';
            mMsg.parts.push(await _convertImageRefToInlineImageOrThrow(aFragment.part, resizeMode));
            break;

          case 'tool_response':
            // TODO
            console.warn('conversationMessagesToAixGenerateRequest: tool_response part not implemented yet');
            break;

        }
        return mMsg;
      }, Promise.resolve({ role: 'model', parts: [] } as AixChatMessageModel));

      acc.chatSequence.push(aixChatMessageModel);

    } else {
      // TODO: impement mid-chat system messages?
      console.warn('historyToChatGenerateRequest: unexpected message role', m.role);
    }

    return acc;
  }, Promise.resolve({ chatSequence: [] } as AixChatContentGenerateRequest));
}

async function _convertImageRefToInlineImageOrThrow(imageRefPart: DMessageImageRefPart, resizeMode: LLMImageResizeMode | false) {

  // validate
  const { dataRef } = imageRefPart;
  if (dataRef.reftype !== 'dblob' || !('dblobAssetId' in dataRef)) {
    console.warn('Image reference is not supported', imageRefPart);
    throw new Error('Image reference is not supported');
  }

  // get image asset
  const imageAsset = await getImageAsset(dataRef.dblobAssetId);
  if (!imageAsset) {
    console.warn('Image asset not found', imageRefPart);
    throw new Error('Image asset not found');
  }

  // convert if requested
  let { mimeType, base64: base64Data } = imageAsset.data;
  if (resizeMode) {
    const resizedData = await resizeBase64ImageIfNeeded(mimeType, base64Data, resizeMode, MODEL_IMAGE_RESCALE_MIMETYPE, MODEL_IMAGE_RESCALE_QUALITY).catch(() => null);
    if (resizedData) {
      base64Data = resizedData.base64;
      mimeType = resizedData.mimeType as any;
    }
  }

  return createAixInlineImagePart(base64Data, mimeType || dataRef.mimeType);
}
