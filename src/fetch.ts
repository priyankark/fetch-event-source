import { parseStream, EventSourceMessage } from './parse';

export const EventStreamContentType = 'text/event-stream';

const DefaultRetryInterval = 1000;

export interface FetchEventSourceInit extends RequestInit {
    /**
     * The request headers. FetchEventSource only supports the Record<string,string> format.
     */
    headers?: Record<string, string>,

    /**
     * Called when a response is received. Use this to validate that the response
     * actually matches what you expect (and throw if it doesn't.) If not provided,
     * will default to a basic validation to ensure the content-type is text/event-stream.
     */
    onopen?: (response: Response) => Promise<void>,

    /**
     * Called when a message is received. NOTE: Unlike the default browser
     * EventSource.onmessage, this callback is called for _all_ events,
     * even ones with a custom `event` field.
     */
    onmessage?: (ev: EventSourceMessage) => void;

    /**
     * Called when a response finishes. If you don't expect the server to kill
     * the connection, you can throw an exception here and retry using onerror.
     */
    onclose?: () => void;

    /**
     * Called when there is any error making the request / processing messages /
     * handling callbacks etc. Use this to control the retry strategy: if the
     * error is fatal, rethrow the error inside the callback to stop the entire
     * operation. Otherwise, you can return an interval (in milliseconds) after
     * which the request will automatically retry (with the last-event-id).
     * If this callback is not specified, or it returns undefined, fetchEventSource
     * will treat every error as retriable and will try again after 1 second.
     */
    onerror?: (err: any) => number | null | undefined | void,

    /**
     * If true, will keep the request open even if the document is hidden.
     * By default, fetchEventSource will close the request and reopen it
     * automatically when the document becomes visible again.
     */
    openWhenHidden?: boolean;

    /** The Fetch function to use. Defaults to window.fetch */
    fetch?: typeof fetch;
}

export function fetchEventSource(input: RequestInfo, {
    signal: inputSignal,
    headers: inputHeaders,
    onopen: inputOnOpen,
    onmessage,
    onclose,
    onerror,
    openWhenHidden,
    fetch: inputFetch,
    ...rest
}: FetchEventSourceInit) {
    return new Promise<void>((resolve, reject) => {
        // make a copy of the input headers since we may modify it below:
        const headers = { ...inputHeaders };
        if (!headers.accept) {
            headers.accept = EventStreamContentType;
        }

        let curRequestController: AbortController;
        function onVisibilityChange() {
            curRequestController.abort(); // close existing request on every visibility change
            if (!document.hidden) {
                create(); // page is now visible again, recreate request.
            }
        }

        if (!openWhenHidden) {
            document.addEventListener('visibilitychange', onVisibilityChange);
        }

        let retryInterval = DefaultRetryInterval;
        let retryTimer = 0;
        function dispose() {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.clearTimeout(retryTimer);
            curRequestController.abort();
        }

        // if the incoming signal aborts, dispose resources and resolve:
        inputSignal?.addEventListener('abort', () => {
            dispose();
            resolve(); // don't waste time constructing/logging errors
        });

        async function parseResponse(response: Response) {
            for await (const msg of parseStream(response.body)) {
                // first check for system events:
                if (msg.id !== undefined) {
                    // keep track of the last-seen ID and send it back on the next retry:
                    headers['last-event-id'] = msg.id;
                }

                if (msg.retry !== undefined) {
                    retryInterval = msg.retry;
                }

                if (msg.data !== undefined && onmessage != null) {
                    onmessage(msg);
                }
            }
        }

        const fetch = inputFetch ?? window.fetch;
        const onopen = inputOnOpen ?? defaultOnOpen;
        async function create() {
            curRequestController = new AbortController();
            try {
                const response = await fetch(input, {
                    ...rest,
                    headers,
                    signal: curRequestController.signal,
                });

                await onopen(response);

                await parseResponse(response);

                onclose?.();
                dispose();
                resolve();
            } catch (err) {
                if (!curRequestController.signal.aborted) {
                    // if we haven't aborted the request ourselves:
                    try {
                        // check if we need to retry:
                        const interval: any = onerror?.(err) ?? retryInterval;
                        window.clearTimeout(retryTimer);
                        retryTimer = window.setTimeout(create, interval);
                    } catch (innerErr) {
                        // we should not retry anymore:
                        dispose();
                        reject(innerErr);
                    }
                }
            }
        }

        create();
    });
}

function defaultOnOpen(response: Response) {
    const contentType = response.headers.get('content-type');
    if (contentType !== EventStreamContentType) {
        throw new Error(`Expected content-type to be ${EventStreamContentType}, Actual: ${contentType}`);
    }
}