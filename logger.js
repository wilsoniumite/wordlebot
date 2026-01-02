import pino from 'pino';
import pinoHttp from 'pino-http';

// Create base logger with OpenTelemetry transport
const logger = pino({
    level: process.env.OTEL_LOG_LEVEL || 'info',
    transport: {
        targets: [
            {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    singleLine: true
                }
            },
            {
                target: 'pino-opentelemetry-transport',
                options: {
                    resourceAttributes: {
                        'service.name': process.env.OTEL_SERVICE_NAME || 'discord-wordle-bot',
                        'deployment.environment': process.env.NODE_ENV || 'production',
                    }
                }
            }
        ]
    },
});

// HTTP request logger middleware (adds request IDs automatically)
const httpLogger = pinoHttp({
    logger,
    genReqId: (req, res) => {
        // Generate request ID if not present
        return req.id || crypto.randomUUID();
    },
    customProps: (req) => ({
        interactionId: req.body?.id,
        guildId: req.body?.guild_id,
        channelId: req.body?.channel_id,
        userId: req.body?.member?.user?.id || req.body?.user?.id,
        command: req.body?.data?.name,
        interactionType: req.body?.type,
    }),
    customSuccessMessage: (req, res) => {
        if (req.body?.data?.name) {
            return `${req.body.data.name} first response sent`;
        }
        return 'Request completed';
    },
    customErrorMessage: (req, res, err) => {
        if (req.body?.data?.name) {
            return `${req.body.data.name} command failed: ${err.message}`;
        }
        return `Request failed: ${err.message}`;
    },
});

export { logger, httpLogger };