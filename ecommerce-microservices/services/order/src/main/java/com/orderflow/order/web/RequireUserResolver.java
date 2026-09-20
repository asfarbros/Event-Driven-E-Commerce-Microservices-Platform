package com.orderflow.order.web;

import java.util.List;

import com.orderflow.order.correlation.Correlation;
import org.springframework.core.MethodParameter;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** Binds {@link RequireUser} parameters; see the annotation. */
@Component
public class RequireUserResolver implements HandlerMethodArgumentResolver, WebMvcConfigurer {

    public static final String HEADER = "X-User-Id";

    public static class MissingUserException extends RuntimeException {
        public MissingUserException() {
            super("Missing user identity. Order requests must come through the API Gateway with a valid session.");
        }
    }

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return parameter.hasParameterAnnotation(RequireUser.class) && parameter.getParameterType() == String.class;
    }

    @Override
    public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mav, NativeWebRequest request, WebDataBinderFactory binder) {
        String userId = request.getHeader(HEADER);
        if (userId == null || !Correlation.isValid(userId)) {
            throw new MissingUserException();
        }
        return userId;
    }

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(this);
    }
}
