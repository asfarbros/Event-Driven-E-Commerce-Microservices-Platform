package com.orderflow.order.web;

import java.io.IOException;

import com.orderflow.order.correlation.Correlation;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * Runs FIRST on every request (the Java twin of the Node services'
 * request-context + logging middleware).
 *
 * <ul>
 *   <li>Correlation: reuse the gateway's {@code X-Request-Id} when well-formed,
 *       otherwise mint one; put it in the MDC (so every log line carries
 *       {@code requestId}) and echo it in the response header.</li>
 *   <li>Identity: {@code X-User-Id}, when present, goes into the MDC as
 *       {@code userId}. It is TRUSTED because the API Gateway is the only
 *       ingress and strips any client-supplied value before injecting the
 *       verified one. {@code RequireUser} turns a missing header into 401 —
 *       there is no fallback to a body field or query param, ever.</li>
 *   <li>One structured line per request:
 *       {@code { requestId, req: {method, url}, res: {status}, durationMs, msg }}</li>
 * </ul>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CorrelationFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger("http");
    static final String USER_HEADER = "X-User-Id";
    static final String MDC_USER = "userId";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String inbound = request.getHeader(Correlation.HEADER);
        String requestId = Correlation.isValid(inbound) ? inbound : Correlation.newId();
        Correlation.set(requestId);
        response.setHeader(Correlation.HEADER, requestId);

        String userId = request.getHeader(USER_HEADER);
        if (userId != null && Correlation.isValid(userId)) {
            MDC.put(MDC_USER, userId);
        }

        long started = System.nanoTime();
        try {
            chain.doFilter(request, response);
        } finally {
            long durationMs = (System.nanoTime() - started) / 1_000_000;
            int status = response.getStatus();
            String url = request.getQueryString() == null ? request.getRequestURI()
                    : request.getRequestURI() + "?" + request.getQueryString();
            String msg = request.getMethod() + " " + url + " -> " + status;
            var req = kv("req", new Req(request.getMethod(), url, request.getRemoteAddr()));
            var res = kv("res", new Res(status));
            if (status >= 500) {
                log.error(msg, req, res, kv("durationMs", durationMs));
            } else if (status >= 400) {
                log.warn(msg, req, res, kv("durationMs", durationMs));
            } else {
                log.info(msg, req, res, kv("durationMs", durationMs));
            }
            MDC.remove(MDC_USER);
            Correlation.clear();
        }
    }

    record Req(String method, String url, String ip) {
    }

    record Res(int status) {
    }
}
