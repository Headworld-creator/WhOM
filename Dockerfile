# WhOM — PHP + Apache image for Render (serves the frontend AND the API from one origin)
FROM php:8.3-apache

RUN docker-php-ext-install pdo_mysql \
 && a2enmod rewrite headers expires setenvif \
 && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini" \
 && sed -ri 's/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf \
 && echo 'ServerName localhost' > /etc/apache2/conf-available/servername.conf \
 && a2enconf servername

WORKDIR /var/www/html
COPY --chown=www-data:www-data . /var/www/html
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Render injects PORT (default 10000); the entrypoint points Apache at it.
EXPOSE 10000
ENTRYPOINT ["entrypoint.sh"]
