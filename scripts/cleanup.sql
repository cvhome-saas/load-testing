-- Removes everything the load tests created, by the k6- prefix. Run after scripts/cleanup.sh's API pass.
-- Table and column names below were taken from the schema.sql files of each service; re-check with \d
-- before the first run on a new version of the application.
\set ON_ERROR_STOP off

-- shoppers (cua realm users) and staff (uaa) created by the suite
delete from cua.users        where username like 'k6-%' or email like 'k6-%@load.test';
delete from uaa.users        where username like 'k6-%@load.test' or email like 'k6-%@load.test';

-- orders and carts on any store (guest orders carry the k6 e-mail domain)
delete from checkout.order_history where order_id in (select id from checkout.orders where customer_email_address like '%@load.test');
delete from checkout.order_product where order_id in (select id from checkout.orders where customer_email_address like '%@load.test');
delete from checkout.orders        where customer_email_address like '%@load.test';
delete from checkout.shopping_cart_item where shopping_cart_id in (select shopping_cart_id from checkout.shopping_cart where store_merchant_id in (select id from tenancy.manager_store where name like 'k6-%'));
delete from checkout.shopping_cart      where store_merchant_id in (select id from tenancy.manager_store where name like 'k6-%');

-- pod data of the k6- stores
delete from inventory.inventory  where store_merchant_id in (select id from tenancy.manager_store where name like 'k6-%');
delete from catalog.product      where store_merchant_id in (select id from tenancy.manager_store where name like 'k6-%');
delete from catalog.category     where store_merchant_id in (select id from tenancy.manager_store where name like 'k6-%');
delete from content.page         where store_merchant_id in (select id from tenancy.manager_store where name like 'k6-%');
delete from merchant.store_domains  where store_merchant_id in (select id from tenancy.manager_store where name like 'k6-%');
delete from merchant.merchant_store where store_merchant_id in (select id from tenancy.manager_store where name like 'k6-%');

-- platform rows (order matters: subscription -> placement -> store -> org)
delete from billing.store_subscription where id in (select id from tenancy.manager_store where name like 'k6-%');
delete from pod_registry.pod_store_placement where store_id in (select id from tenancy.manager_store where name like 'k6-%');
-- placements whose store no longer exists still count against the pod's capacity
delete from pod_registry.pod_store_placement where store_id not in (select id from tenancy.manager_store);
delete from tenancy.manager_store where name like 'k6-%';
delete from tenancy.organization  where name like 'k6-%';
