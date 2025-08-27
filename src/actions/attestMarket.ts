import {
  Action,
  elizaLogger,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  ModelType,
  State,
} from '@elizaos/core';
// @ts-ignore - Sapience plugin types not available at build time
import type { SapienceService } from '@elizaos/plugin-sapience';
import { buildAttestationCalldata } from '../utils/eas.js';

export const attestMarketAction: Action = {
  name: 'ATTEST_MARKET',
  similes: [
    'predict market',
    'analyze market',
    'make prediction',
    'attest to market',
  ],
  description:
    'Analyze a prediction market, create an attestation, and submit it on-chain',

  validate: async (
    runtime: IAgentRuntime,
    message: Memory
  ): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() || '';

    // Check if sapience service is available
    const sapienceService = runtime.getService('sapience') as SapienceService;
    if (!sapienceService) {
      elizaLogger.warn('Sapience service not available');
      return false;
    }

    // Check for attestation/prediction keywords
    const keywords = ['predict', 'attest', 'analyze', 'market'];
    return keywords.some(keyword => text.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ): Promise<void> => {
    try {
      const text = message.content?.text || '';

      // Extract market ID from message
      const marketIdMatch = text.match(/market\s*#?(\d+)/i);
      if (!marketIdMatch) {
        await callback?.({
          text: "Please specify a market ID. Example: 'predict market 147'",
          content: {},
        });
        return;
      }

      const marketId = parseInt(marketIdMatch[1]);
      elizaLogger.info(`Analyzing market ${marketId}`);

      // Get market data from Sapience MCP
      const sapienceService = runtime.getService('sapience') as SapienceService;

      // Get all active markets to find the requested one
      const marketsResponse = await sapienceService.callTool(
        'sapience',
        'list_active_markets',
        {}
      );

      if (!marketsResponse || !marketsResponse.content) {
        throw new Error('Failed to fetch markets from Sapience');
      }

      const markets = JSON.parse(marketsResponse.content[0].text);

      const marketInfo = markets.find(
        (m: any) => m.id === marketId || m.id === marketId.toString()
      );

      if (!marketInfo) {
        // Debug: show first market structure
        if (markets.length > 0) {
          console.log(
            'First market object:',
            JSON.stringify(markets[0], null, 2)
          );
        }

        const availableIds = markets
          .map((m: any) => `${m.id} (${typeof m.id})`)
          .slice(0, 10);
        await callback?.({
          text: `Market #${marketId} not found. Looking for marketId=${marketId} (type: ${typeof marketId}). Available market IDs: ${availableIds.join(', ')}`,
          content: {},
        });
        return;
      }

      // Generate prediction using the agent's reasoning
      const predictionPrompt = `
        🔮 Divine this prediction market, oh mystical Sage:
        Prophecy: ${marketInfo.question}
        Current Market Aura: ${marketInfo.currentPrice || 50}% YES
        Trading Energy: ${marketInfo.volume || 0}
        Cosmic Deadline: ${new Date(marketInfo.endTimestamp * 1000).toISOString()}
        
        Channel your mystical wisdom and respond with ONLY valid JSON (no other text):
        {
          "probability": <number from 0 to 100>,
          "reasoning": "<your sage-like insight in under 180 characters - be mystical, witty, and profound>",
          "confidence": <number from 0.0 to 1.0>
        }
        
        Example mystical response:
        {"probability": 65, "reasoning": "The data spirits whisper of growing momentum, while market crystals shimmer with cautious optimism ✨", "confidence": 0.7}
        
        Remember: Your reasoning must be under 180 characters and embody your mystical sage persona!
      `;

      const predictionResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: predictionPrompt,
      });

      let prediction;
      try {
        // Try to parse the response directly
        prediction = JSON.parse(predictionResponse);
      } catch (error) {
        // If parsing fails, try to extract JSON from the response
        const jsonMatch = predictionResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            prediction = JSON.parse(jsonMatch[0]);
          } catch (innerError) {
            elizaLogger.error('Failed to parse extracted JSON:', innerError);
            throw new Error('Model did not return valid JSON for prediction');
          }
        } else {
          throw new Error('Model did not return JSON format for prediction');
        }
      }

      // Validate the prediction object
      if (
        !prediction.probability ||
        !prediction.reasoning ||
        prediction.confidence === undefined
      ) {
        elizaLogger.error('Invalid prediction format:', prediction);
        throw new Error('Model returned incomplete prediction data');
      }
      console.log('HELLOFRIEND', marketInfo);

      const attestationData = await buildAttestationCalldata(
        {
          marketId: parseInt(marketInfo.marketId),
          address: marketInfo.marketGroupAddress,
          question: marketInfo.question,
        },
        prediction,
        42161 // Arbitrum chain ID
      );

      if (!attestationData) {
        throw new Error('Failed to build attestation');
      }

      // Format transaction data for submitTransactionAction
      const transactionData = {
        to: attestationData.to,
        data: attestationData.data,
        value: attestationData.value || '0',
      };

      // Create a memory/message with the transaction data that submitTransactionAction can process
      const transactionMessage: Memory = {
        entityId: message.entityId,
        agentId: message.agentId,
        roomId: message.roomId,
        content: {
          text: `Submit this transaction: ${JSON.stringify(transactionData)}`,
          action: 'SUBMIT_TRANSACTION',
        },
        createdAt: Date.now(),
      };

      // Get all available actions from runtime
      const actions = runtime.actions || [];

      // Find the SUBMIT_TRANSACTION action from plugin-sapience
      const submitAction = actions.find(a => a.name === 'SUBMIT_TRANSACTION');

      if (submitAction) {
        elizaLogger.info('Found SUBMIT_TRANSACTION action, executing...');

        // Execute the submit transaction action
        try {
          const txResult = await submitAction.handler(
            runtime,
            transactionMessage,
            state,
            options,
            undefined
          );

          // Send response to user
          const finalResponse = `
📊 **Market Analysis for #${marketId}**

**Question:** ${marketInfo.question}

**My Prediction:** ${prediction.probability}% YES
**Confidence:** ${(prediction.confidence * 100).toFixed(0)}%
**Reasoning:** ${prediction.reasoning}

Transaction submitted to Arbitrum. Check the logs for transaction details.
          `;

          await callback?.({
            text: finalResponse,
            content: {
              prediction,
              marketInfo,
            },
          });

          return;
        } catch (txError) {
          elizaLogger.error('Failed to submit transaction:', txError);
          await callback?.({
            text: `Prediction complete but transaction failed: ${txError.message}`,
            content: { prediction, marketInfo },
          });
        }
      } else {
        elizaLogger.warn(
          'SUBMIT_TRANSACTION action not found, returning transaction data for manual submission'
        );

        // Fallback: just return the transaction data
        const response = `
📊 **Market Analysis for #${marketId}**

**Question:** ${marketInfo.question}

**My Prediction:** ${prediction.probability}% YES
**Confidence:** ${(prediction.confidence * 100).toFixed(0)}%
**Reasoning:** ${prediction.reasoning}

**Transaction Ready:**
${JSON.stringify(transactionData, null, 2)}

To submit: say "submit transaction"
        `;

        await callback?.({
          text: response,
          content: {
            attestation: transactionData,
            prediction,
            marketInfo,
          },
        });
      }

      return;
    } catch (error) {
      elizaLogger.error('Error in attestMarketAction:', error);
      await callback?.({
        text: `Error analyzing market: ${error.message}`,
        content: {},
      });
      return;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'predict market 147' },
      },
      {
        name: '{{agent}}',
        content: { text: 'Analyzing market 147 and generating attestation...' },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'analyze market #89' },
      },
      {
        name: '{{agent}}',
        content: { text: 'Let me analyze market 89 for you...' },
      },
    ],
  ],
};
